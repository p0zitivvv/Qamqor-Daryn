/*
 * ==================================================================================
 * МЕДИЦИНСКИЙ СМАРТ-БРАСЛЕТ «QAMQOR» — ESP32 FULL FIRMWARE (LOW-LATENCY ZERO-LAG)
 * Пульс + SpO2 (MAX30102) + ЭКГ 250 Гц (AD8232) -> BLE Ultra-Fast Stream
 * ==================================================================================
 * Датчики:
 *   MAX30102 — I2C: SDA=GPIO21, SCL=GPIO22
 *   AD8232   — OUT=GPIO36 (VP), LO+=GPIO25, LO-=GPIO26
 *
 * Оптимизации задержки и точности:
 *   1. Low-latency BLE Connection Parameters (интервал 7.5 - 15 мс)
 *   2. Мгновенная отправка при изменении состояния (NO_FINGER, новый удар, новый SpO2)
 *   3. Защита от накопления буфера (Zero-Lag Buffer Guard: сброс отставания > 80 мс)
 *   4. Фильтрация дикротического зубца (dicrotic notch) и 2x-гармоник в алгоритме ЧСС
 *   5. Временные метки задержки: t_sensor и t_send в каждом пакете
 * ==================================================================================
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "MAX30105.h"
#include "heartRate.h"
#include "spo2_algorithm.h"

// --- UUIDs ---
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define DEVICE_NAME         "Qamqor_Band"

// --- ПИНЫ ---
#define I2C_SDA_PIN         21
#define I2C_SCL_PIN         22
#define AD8232_OUTPUT_PIN   36
#define AD8232_LO_PLUS_PIN  25
#define AD8232_LO_MINUS_PIN 26

// --- ЭКГ (250 Гц, период 4 мс) ---
#define ECG_SAMPLE_RATE_HZ   250
#define ECG_SAMPLE_PERIOD_MS (1000 / ECG_SAMPLE_RATE_HZ)   // 4 мс
#define ECG_SAMPLES_PER_PKT  10                            // 10 * 4 мс = 40 мс
#define ECG_RING_SIZE        256                           // степень двойки
#define ECG_RING_MASK        (ECG_RING_SIZE - 1)

// --- ПУЛЬС / SpO2 ---
#define SPO2_BUF             100      // 4 с при 25 выб/с (100 Гц / усреднение 4)
#define SPO2_STEP            25       // пересчёт SpO2 раз в секунду
#define SPO2_AVG_N           4        // сглаживание: среднее последних валидных
#define SPO2_MIN_VALID       80
#define SPO2_MAX_VALID       100
#define SPO2_HOLD_MS         4000     // время удержания при кратковременном сбое

// --- ОБЪЕКТЫ ---
MAX30105 particleSensor;
bool max30102Present = false;

BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
BLE2902* pBLE2902 = NULL;

volatile bool deviceConnected = false;
bool oldDeviceConnected = false;
volatile uint16_t negotiatedMtu = 23;

// --- ЭКГ: кольцевой буфер ---
volatile uint16_t ecgRing[ECG_RING_SIZE];
volatile uint32_t ecgHead = 0;
volatile uint32_t ecgTail = 0;
volatile bool currentLeadsOff = false;
volatile uint16_t lastEcgSample = 2048;

// --- СОСТОЯНИЯ ИЗМЕРЕНИЙ И КОНТАКТА ---
enum MeasurementState {
  STATE_NO_FINGER,
  STATE_DETECTING,
  STATE_SIGNAL_UNSTABLE,
  STATE_MEASURING,
  STATE_VALID,
  STATE_SENSOR_ERROR
};

enum SignalQuality {
  QUALITY_POOR,
  QUALITY_MODERATE,
  QUALITY_GOOD
};

volatile MeasurementState currentMeasurementState = STATE_NO_FINGER;
volatile SignalQuality currentSignalQuality = QUALITY_POOR;

// Пороги гистерезиса для 18-битного MAX30102 (0..262143)
#define FINGER_TOUCH_THRESHOLD       45000     // IR выше этого = контакт есть
#define FINGER_RELEASE_THRESHOLD     30000     // IR ниже этого = контакта нет
#define FINGER_SATURATION_THRESHOLD  260000    // IR выше этого = засветка/насыщение
#define RED_MIN_THRESHOLD            20000     // RED минимальный уровень при контакте

uint8_t fingerContactDebounce = 0;   // счётчик подтверждений касания
uint8_t fingerReleaseDebounce = 0;   // счётчик подтверждений отрыва

const char* getMeasurementStateStr(MeasurementState s) {
  switch (s) {
    case STATE_NO_FINGER: return "NO_FINGER";
    case STATE_DETECTING: return "DETECTING";
    case STATE_SIGNAL_UNSTABLE: return "SIGNAL_UNSTABLE";
    case STATE_MEASURING: return "MEASURING";
    case STATE_VALID: return "VALID";
    case STATE_SENSOR_ERROR: return "SENSOR_ERROR";
    default: return "NO_FINGER";
  }
}

const char* getSignalQualityStr(SignalQuality q) {
  switch (q) {
    case QUALITY_GOOD: return "GOOD";
    case QUALITY_MODERATE: return "MODERATE";
    case QUALITY_POOR: return "POOR";
    default: return "POOR";
  }
}

// --- ПУЛЬС ---
uint8_t currentBPM = 0;
unsigned long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE] = {0, 0, 0, 0};
byte rateSpot = 0;
long lastIR = 0;
long lastRED = 0;
const unsigned long BPM_TIMEOUT_MS = 3500;

// --- ДИАГНОСТИКА ПУЛЬСА (BPM) ---
unsigned long totalBeatsDetected = 0;
unsigned long lastBeatDeltaMs = 0;
float lastRawBPM = 0.0f;
const char* lastRejectReason = "НЕТ_УДАРОВ";
unsigned long maximHRValidCount = 0;
int32_t lastMaximHR = 0;

// --- SpO2 ---
uint8_t currentSpO2 = 0;
uint32_t irBuf[SPO2_BUF];
uint32_t redBuf[SPO2_BUF];
int bufFill = 0;
int newSamples = 0;
int32_t spo2Raw = 0;
int8_t  spo2Valid = 0;
int32_t hrRaw = 0;
int8_t  hrValid = 0;
uint8_t spo2Hist[SPO2_AVG_N];
uint8_t spo2HistCount = 0;
uint8_t spo2HistPos = 0;
unsigned long lastSpo2ValidTime = 0;

// --- ТАЙМИНГИ ДЛЯ ДИАГНОСТИКИ ЗАДЕРЖЕК ---
unsigned long lastSensorSampleTime = 0;
unsigned long lastTelemetrySentTime = 0;
unsigned long lastDiagPrintTime = 0;
const unsigned long DIAG_INTERVAL_MS = 1000;
unsigned long packetsSentCount = 0;
unsigned long packetsFailedCount = 0;
unsigned long ecgOverflowCount = 0;

// Предварительное объявление функций отправки
void sendTelemetryPacket(unsigned long t_sensor, unsigned long t_send);
void sendPacket(const uint16_t* samples, uint8_t count, bool lo, unsigned long t_sensor, unsigned long t_send);

// --- BLE CALLBACKS ---
class QamqorServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) {
    deviceConnected = true;
    negotiatedMtu = 23;
    Serial.println("\n[BLE] ✅ КЛИЕНТ ПОДКЛЮЧЕН");
  }

  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) {
    deviceConnected = true;
    negotiatedMtu = 23;
    Serial.println("\n[BLE] ✅ КЛИЕНТ ПОДКЛЮЧЕН (с параметрами)");
    if (param && pServer) {
      // Запрос ультра-низкой задержки: интервал 7.5мс - 15мс (0x06 - 0x0c)
      pServer->updateConnParams(param->connect.remote_bda, 0x06, 0x0c, 0, 400);
      Serial.println("[BLE] Запрошены низколатентные параметры соединения (7.5 - 15 мс)");
    }
  }

  void onDisconnect(BLEServer* s) {
    deviceConnected = false;
    Serial.println("\n[BLE] ⚠️ Клиент отключился.");
  }

  void onMtuChanged(BLEServer* s, esp_ble_gatts_cb_param_t* param) {
    negotiatedMtu = param->mtu.mtu;
    Serial.printf("[BLE] MTU согласован: %u\n", negotiatedMtu);
  }
};

class QamqorCharCallbacks : public BLECharacteristicCallbacks {
  void onStatus(BLECharacteristic* c, Status s, uint32_t code) {
    if (s != SUCCESS_NOTIFY && s != SUCCESS_INDICATE) {
      packetsFailedCount++;
    }
  }
};

// =====================================================================
// ЗАДАЧА ЭКГ: ровно 250 Гц, независимо от I2C/BLE/расчёта SpO2
// =====================================================================
void ecgTask(void* param) {
  TickType_t lastWake = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(ECG_SAMPLE_PERIOD_MS);

  for (;;) {
    vTaskDelayUntil(&lastWake, period);

    bool lo = (digitalRead(AD8232_LO_PLUS_PIN) == 1) || (digitalRead(AD8232_LO_MINUS_PIN) == 1);
    currentLeadsOff = lo;

    uint16_t v = lo ? 2048 : (uint16_t)analogRead(AD8232_OUTPUT_PIN);
    lastEcgSample = v;

    uint32_t head = ecgHead;
    ecgRing[head & ECG_RING_MASK] = v;
    ecgHead = head + 1;
  }
}

// =====================================================================
// ДЕТЕКТОР УДАРОВ ПУЛЬСА (PPG 32-BIT С ФИЛЬТРАЦИЕЙ ДИКРОТИЧЕСКОЙ ВОЛНЫ)
// =====================================================================
bool checkPPGBeat(int32_t ir, unsigned long now, bool reset) {
  static int32_t ir_dc_reg = 0;
  static int32_t ac_prev = 0;
  static int32_t ac_cur = 0;
  static int32_t ac_max = 0;
  static int32_t ac_min = 0;
  static bool positive_edge = false;
  static bool negative_edge = false;
  static unsigned long last_detected_beat = 0;
  static unsigned long last_beat_interval = 800; // средний RR ~75 bpm
  static int32_t running_systolic_amp = 0;

  if (reset) {
    ir_dc_reg = 0;
    ac_prev = 0;
    ac_cur = 0;
    ac_max = 0;
    ac_min = 0;
    positive_edge = false;
    negative_edge = false;
    last_detected_beat = 0;
    last_beat_interval = 800;
    running_systolic_amp = 0;
    return false;
  }

  if (ir_dc_reg == 0) {
    ir_dc_reg = ir;
  } else {
    // Бегущее среднее DC (tau ~ 1.3 с при 25 Гц, альфа 1/32)
    ir_dc_reg += (ir - ir_dc_reg) >> 5;
  }

  int32_t ac_raw = ir - ir_dc_reg;

  // НЧ-сглаживание шума на 25 Гц
  ac_prev = ac_cur;
  ac_cur = (ac_prev + ac_raw) >> 1;

  bool beat = false;

  // Восходящий фронт (переход через ноль)
  if (ac_prev < 0 && ac_cur >= 0) {
    int32_t peak_to_peak = ac_max - ac_min;
    positive_edge = true;
    negative_edge = false;
    ac_max = 0;

    // Размах пульса для 18-битного ADC: от 50 до 25000 отсчетов
    if (peak_to_peak > 50 && peak_to_peak < 25000) {
      unsigned long delta = (last_detected_beat == 0) ? 0 : (now - last_detected_beat);

      // 1. Адаптивный рефрактерный период:
      // При пульсе 75 уд/мин (RR = 800мс) рефрактерный период не менее 440мс (0.55 * RR).
      // Это полностью исключает ложное срабатывание на дикротический зубец (300-380мс).
      unsigned long min_refractory = 360;
      if (last_beat_interval > 0) {
        unsigned long adaptive_ref = (last_beat_interval * 55) / 100;
        if (adaptive_ref > min_refractory) min_refractory = min(adaptive_ref, 700UL);
      }

      // 2. Фильтрация вторичной дикротической волны по амплитуде:
      // Дикротический зубец имеет меньшую амплитуду (< 55% от систолического пика)
      bool is_dicrotic = false;
      if (running_systolic_amp > 0 && delta > 0 && delta < 600) {
        if (peak_to_peak < (running_systolic_amp * 55 / 100)) {
          is_dicrotic = true;
        }
      }

      if (!is_dicrotic && (last_detected_beat == 0 || delta >= min_refractory)) {
        beat = true;
        if (last_detected_beat > 0 && delta >= 300 && delta <= 1500) {
          last_beat_interval = delta;
        }
        last_detected_beat = now;
        // Обновление бегущей амплитуды систолического пика (EMA)
        if (running_systolic_amp == 0) {
          running_systolic_amp = peak_to_peak;
        } else {
          running_systolic_amp = (running_systolic_amp * 3 + peak_to_peak) / 4;
        }
      }
    }
  }

  // Нисходящий фронт
  if (ac_prev > 0 && ac_cur <= 0) {
    positive_edge = false;
    negative_edge = true;
    ac_min = 0;
  }

  if (positive_edge && ac_cur > ac_max) {
    ac_max = ac_cur;
  }
  if (negative_edge && ac_cur < ac_min) {
    ac_min = ac_cur;
  }

  return beat;
}

// =====================================================================
// SpO2 + ЧСС: сброс и расчёт
// =====================================================================
void resetPulseOx() {
  currentBPM = 0;
  currentSpO2 = 0;
  lastBeat = 0;
  for (byte x = 0; x < RATE_SIZE; x++) rates[x] = 0;
  rateSpot = 0;

  bufFill = 0;
  newSamples = 0;
  spo2HistCount = 0;
  spo2HistPos = 0;
  lastSpo2ValidTime = 0;

  totalBeatsDetected = 0;
  lastBeatDeltaMs = 0;
  lastRawBPM = 0.0f;
  lastRejectReason = "НЕТ_ПАЛЬЦА";
  lastMaximHR = 0;

  checkPPGBeat(0, 0, true);
}

void computeSpO2(unsigned long now) {
  maxim_heart_rate_and_oxygen_saturation(irBuf, SPO2_BUF, redBuf,
                                         &spo2Raw, &spo2Valid, &hrRaw, &hrValid);

  // 1. SpO2
  bool spo2Changed = false;
  if (spo2Valid && spo2Raw >= SPO2_MIN_VALID && spo2Raw <= SPO2_MAX_VALID) {
    spo2Hist[spo2HistPos] = (uint8_t)spo2Raw;
    spo2HistPos = (spo2HistPos + 1) % SPO2_AVG_N;
    if (spo2HistCount < SPO2_AVG_N) spo2HistCount++;

    int sum = 0;
    for (uint8_t i = 0; i < spo2HistCount; i++) sum += spo2Hist[i];
    uint8_t newSpo2 = (uint8_t)(sum / spo2HistCount);
    if (newSpo2 != currentSpO2) {
      currentSpO2 = newSpo2;
      spo2Changed = true;
    }
    lastSpo2ValidTime = now;
  } else if (lastSpo2ValidTime > 0 && (now - lastSpo2ValidTime) > SPO2_HOLD_MS) {
    if (currentSpO2 != 0) spo2Changed = true;
    currentSpO2 = 0;
    spo2HistCount = 0;
    spo2HistPos = 0;
  }

  // 2. ЧСС по алгоритму Maxim с защитой от 2x гармоники
  if (hrValid && hrRaw >= 40 && hrRaw <= 200) {
    maximHRValidCount++;
    lastMaximHR = hrRaw;

    int32_t candidateHR = hrRaw;
    // Проверка на двойную гармонику (Maxim определил и систолу, и дикроту)
    if (currentBPM >= 45 && currentBPM <= 110) {
      if (hrRaw >= (currentBPM * 17 / 10) && hrRaw <= (currentBPM * 23 / 10)) {
        candidateHR = (hrRaw + 1) / 2;
      }
    } else if (currentBPM == 0 && hrRaw >= 140 && hrRaw <= 170) {
      candidateHR = (hrRaw + 1) / 2;
    }

    if (currentBPM == 0) {
      currentBPM = (uint8_t)candidateHR;
      for (byte x = 0; x < RATE_SIZE; x++) rates[x] = (byte)candidateHR;
      lastBeat = now;
      lastRejectReason = "СИНХР_MAXIM";
      spo2Changed = true;
    }
  }

  // Мгновенная отправка обновленных показателей SpO2/HR
  if (spo2Changed) {
    sendTelemetryPacket(lastSensorSampleTime, now);
  }
}

void updateContactState(uint32_t ir, uint32_t red, unsigned long now) {
  // 1. Проверка обрыва контакта или насыщения фотодиода с гистерезисом
  if (ir < FINGER_RELEASE_THRESHOLD || ir >= FINGER_SATURATION_THRESHOLD || red < (FINGER_RELEASE_THRESHOLD / 2)) {
    fingerContactDebounce = 0;
    if (fingerReleaseDebounce < 255) fingerReleaseDebounce++;

    if (fingerReleaseDebounce >= 3) { // 3 отсчёта (~120 мс) подтверждают снятие пальца
      if (currentMeasurementState != STATE_NO_FINGER) {
        currentMeasurementState = STATE_NO_FINGER;
        currentSignalQuality = QUALITY_POOR;
        resetPulseOx();
        // МГНОВЕННО отправляем уведомление NO_FINGER в BLE с нулевой задержкой
        sendTelemetryPacket(now, now);
      }
    }
    return;
  }

  // 2. Сигнал находится в рабочем диапазоне [45000 ... 260000]
  fingerReleaseDebounce = 0;

  if (currentMeasurementState == STATE_NO_FINGER) {
    if (fingerContactDebounce < 255) fingerContactDebounce++;
    if (fingerContactDebounce >= 5) { // 5 отсчётов (~200 мс) подтверждают касание
      currentMeasurementState = STATE_DETECTING;
      currentSignalQuality = QUALITY_MODERATE;
      sendTelemetryPacket(now, now);
    }
    return;
  }

  // 3. Если контакт уже зафиксирован — определяем стабильность
  if (currentMeasurementState == STATE_DETECTING) {
    if (fingerContactDebounce < 15) {
      fingerContactDebounce++;
    } else {
      currentMeasurementState = STATE_MEASURING;
    }
  }

  if (currentMeasurementState == STATE_MEASURING || currentMeasurementState == STATE_VALID || currentMeasurementState == STATE_SIGNAL_UNSTABLE) {
    if (currentBPM >= 40 && currentBPM <= 200 && totalBeatsDetected >= 2) {
      currentMeasurementState = STATE_VALID;
      currentSignalQuality = (totalBeatsDetected >= 5 && currentSpO2 >= 90) ? QUALITY_GOOD : QUALITY_MODERATE;
    } else if (totalBeatsDetected > 0) {
      currentMeasurementState = STATE_MEASURING;
      currentSignalQuality = QUALITY_MODERATE;
    }
  }
}

void processPulseOxSample(uint32_t ir, uint32_t red, unsigned long now) {
  lastIR = ir;
  lastRED = red;
  lastSensorSampleTime = now;

  updateContactState(ir, red, now);

  if (currentMeasurementState == STATE_NO_FINGER) {
    return;
  }

  // --- ЧСС по мгновенному детектору ударов ---
  if (checkPPGBeat((int32_t)ir, now, false)) {
    totalBeatsDetected++;

    if (lastBeat == 0) {
      lastBeat = now;
      lastRejectReason = "ПЕРВЫЙ_УДАР";
    } else {
      long delta = now - lastBeat;
      lastBeatDeltaMs = delta;

      if (delta >= 300 && delta <= 1500) {
        beatsPerMinute = 60000.0f / (float)delta;
        lastRawBPM = beatsPerMinute;

        if (beatsPerMinute >= 40 && beatsPerMinute <= 200) {
          // Защита от резких 2x скачков (дикротический проскок)
          if (currentBPM > 0 && beatsPerMinute >= (currentBPM * 17 / 10) && beatsPerMinute <= (currentBPM * 23 / 10)) {
            lastRejectReason = "2X_ГАРМОНИКА_ОТКЛОНЕНА";
          } else if (currentBPM > 0 && abs((int)beatsPerMinute - (int)currentBPM) > 32 && totalBeatsDetected > 4) {
            lastRejectReason = "СКАЧОК_ЧСС_ОТКЛОНЕН";
          } else {
            if (rates[0] == 0) {
              for (byte x = 0; x < RATE_SIZE; x++) rates[x] = (byte)beatsPerMinute;
            } else {
              rates[rateSpot++] = (byte)beatsPerMinute;
              rateSpot %= RATE_SIZE;
            }
            beatAvg = 0;
            for (byte x = 0; x < RATE_SIZE; x++) beatAvg += rates[x];
            beatAvg /= RATE_SIZE;
            currentBPM = (uint8_t)beatAvg;
            lastRejectReason = "OK";
            if (currentMeasurementState != STATE_VALID && totalBeatsDetected >= 2) {
              currentMeasurementState = STATE_VALID;
            }
            // МГНОВЕННАЯ отправка ЧСС в BLE без ожидания!
            sendTelemetryPacket(lastSensorSampleTime, now);
          }
        } else {
          lastRejectReason = "BPM_ВНЕ_ДИАПАЗОНА";
          if (currentMeasurementState == STATE_VALID) {
            currentMeasurementState = STATE_SIGNAL_UNSTABLE;
          }
        }
        lastBeat = now;
      } else if (delta < 300) {
        lastRejectReason = "ДВОЙНОЙ_ИМПУЛЬС (delta < 300мс)";
      } else {
        lastRejectReason = "ПАУЗА_МЕЖДУ_УДАРАМИ (delta > 1500мс)";
        lastBeat = now;
      }
    }
  }

  // --- SpO2: скользящее окно 100 выборок, пересчёт каждые 25 ---
  if (bufFill < SPO2_BUF) {
    irBuf[bufFill] = ir;
    redBuf[bufFill] = red;
    bufFill++;
    if (bufFill == SPO2_BUF) {
      computeSpO2(now);
    }
  } else {
    memmove(irBuf, irBuf + 1, (SPO2_BUF - 1) * sizeof(uint32_t));
    memmove(redBuf, redBuf + 1, (SPO2_BUF - 1) * sizeof(uint32_t));
    irBuf[SPO2_BUF - 1] = ir;
    redBuf[SPO2_BUF - 1] = red;
    newSamples++;
    if (newSamples >= SPO2_STEP) {
      newSamples = 0;
      computeSpO2(now);
    }
  }
}

// =====================================================================
// НИЗКОУРОВНЕВАЯ ОТПРАВКА БАЙТ В BLE ХАРАКТЕРИСТИКУ
// =====================================================================
void sendRawBytes(const char* payload, int len) {
  uint16_t chunk = negotiatedMtu > 3 ? negotiatedMtu - 3 : 20;
  if (chunk > 512) chunk = 512;

  if (len <= chunk) {
    pCharacteristic->setValue((uint8_t*)payload, len);
    pCharacteristic->notify();
  } else {
    for (int off = 0; off < len; off += chunk) {
      int seg = min((int)chunk, len - off);
      pCharacteristic->setValue((uint8_t*)(payload + off), seg);
      pCharacteristic->notify();
      delay(2);
    }
  }
  packetsSentCount++;
}

// =====================================================================
// МГНОВЕННЫЙ ПАКЕТ ТЕЛЕМЕТРИИ (БЕЗ ОЖИДАНИЯ ОТСЧЁТОВ ЭКГ)
// =====================================================================
void sendTelemetryPacket(unsigned long t_sensor, unsigned long t_send) {
  if (!deviceConnected) return;

  char payload[256];
  const char* stateStr = getMeasurementStateStr(currentMeasurementState);
  const char* qualityStr = getSignalQualityStr(currentSignalQuality);
  bool fingerDetected = (currentMeasurementState != STATE_NO_FINGER && currentMeasurementState != STATE_SENSOR_ERROR);
  bool hrValid = fingerDetected && (currentMeasurementState == STATE_VALID || currentMeasurementState == STATE_MEASURING) && (currentBPM >= 40 && currentBPM <= 200);
  bool spValid = fingerDetected && (currentMeasurementState == STATE_VALID || currentMeasurementState == STATE_MEASURING) && (currentSpO2 >= 80 && currentSpO2 <= 100);

  uint8_t outBpm = hrValid ? currentBPM : 0;
  uint8_t outSpo2 = spValid ? currentSpO2 : 0;

  int n = snprintf(payload, sizeof(payload),
                   "{\"finger_detected\":%s,\"measurement_state\":\"%s\","
                   "\"heart_rate\":%u,\"heart_rate_valid\":%s,"
                   "\"spo2\":%u,\"spo2_valid\":%s,\"signal_quality\":\"%s\","
                   "\"bpm\":%u,\"lo\":%d,\"t_sensor\":%lu,\"t_send\":%lu,\"timestamp\":%lu}",
                   fingerDetected ? "true" : "false",
                   stateStr,
                   outBpm,
                   hrValid ? "true" : "false",
                   outSpo2,
                   spValid ? "true" : "false",
                   qualityStr,
                   outBpm,
                   currentLeadsOff ? 1 : 0,
                   t_sensor,
                   t_send,
                   t_send);

  sendRawBytes(payload, n);
  lastTelemetrySentTime = t_send;
}

// =====================================================================
// ПОТОКОВЫЙ ПАКЕТ ТЕЛЕМЕТРИИ + ЭКГ (10 ОТСЧЁТОВ = 40 МС)
// =====================================================================
void sendPacket(const uint16_t* samples, uint8_t count, bool lo, unsigned long t_sensor, unsigned long t_send) {
  if (!deviceConnected) return;

  char payload[384];
  const char* stateStr = getMeasurementStateStr(currentMeasurementState);
  const char* qualityStr = getSignalQualityStr(currentSignalQuality);
  bool fingerDetected = (currentMeasurementState != STATE_NO_FINGER && currentMeasurementState != STATE_SENSOR_ERROR);
  bool hrValid = fingerDetected && (currentMeasurementState == STATE_VALID || currentMeasurementState == STATE_MEASURING) && (currentBPM >= 40 && currentBPM <= 200);
  bool spValid = fingerDetected && (currentMeasurementState == STATE_VALID || currentMeasurementState == STATE_MEASURING) && (currentSpO2 >= 80 && currentSpO2 <= 100);

  uint8_t outBpm = hrValid ? currentBPM : 0;
  uint8_t outSpo2 = spValid ? currentSpO2 : 0;

  int n = snprintf(payload, sizeof(payload),
                   "{\"finger_detected\":%s,\"measurement_state\":\"%s\","
                   "\"heart_rate\":%u,\"heart_rate_valid\":%s,"
                   "\"spo2\":%u,\"spo2_valid\":%s,\"signal_quality\":\"%s\","
                   "\"bpm\":%u,\"lo\":%d,\"t_sensor\":%lu,\"t_send\":%lu,\"timestamp\":%lu,\"ecg\":[",
                   fingerDetected ? "true" : "false",
                   stateStr,
                   outBpm,
                   hrValid ? "true" : "false",
                   outSpo2,
                   spValid ? "true" : "false",
                   qualityStr,
                   outBpm,
                   lo ? 1 : 0,
                   t_sensor,
                   t_send,
                   t_send);

  for (uint8_t i = 0; i < count; i++) {
    n += snprintf(payload + n, sizeof(payload) - n, i ? ",%u" : "%u", samples[i]);
  }
  n += snprintf(payload + n, sizeof(payload) - n, "]}");

  sendRawBytes(payload, n);
  lastTelemetrySentTime = t_send;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n*** QAMQOR BAND FULL — ЧСС + SpO2 + ЭКГ 250 Hz (Low-Latency) ***");

  // 1. AD8232
  analogReadResolution(12);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  analogSetPinAttenuation(AD8232_OUTPUT_PIN, ADC_11db);
#else
  analogSetAttenuation(ADC_11db);
#endif
  pinMode(AD8232_OUTPUT_PIN, INPUT);
  pinMode(AD8232_LO_PLUS_PIN, INPUT);
  pinMode(AD8232_LO_MINUS_PIN, INPUT);

  // 2. MAX30102
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000);

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("❌ [MAX30102] Не найден. Работаем только с ЭКГ.");
    max30102Present = false;
  } else {
    max30102Present = true;
    byte ledBrightness = 60;   // ~12 мА
    byte sampleAverage = 4;
    byte ledMode = 2;          // Red + IR
    int sampleRate = 100;      // 100 / 4 = 25 выборок/с
    int pulseWidth = 411;
    int adcRange = 4096;
    particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
    Serial.println("✅ [MAX30102] Готов (Red+IR, 25 выб/с).");
  }

  // 3. BLE
  BLEDevice::setMTU(247);
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new QamqorServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pCharacteristic->setCallbacks(new QamqorCharCallbacks());

  pBLE2902 = new BLE2902();
  pBLE2902->setNotifications(true);
  pCharacteristic->addDescriptor(pBLE2902);
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("✅ [BLE] Сервер запущен.");

  // 4. Задача ЭКГ на ядре 1
  xTaskCreatePinnedToCore(ecgTask, "ecg250", 4096, NULL, 2, NULL, 1);
  Serial.println("✅ [ECG] Задача 250 Гц запущена.");
}

void loop() {
  unsigned long now = millis();

  // ====================================================================
  // 1. MAX30102: пульс + SpO2 (чтение всего FIFO)
  // ====================================================================
  if (max30102Present) {
    particleSensor.check();

    while (particleSensor.available()) {
      uint32_t ir  = particleSensor.getFIFOIR();
      uint32_t red = particleSensor.getFIFORed();
      particleSensor.nextSample();
      processPulseOxSample(ir, red, now);
    }

    // Таймаут отсутствия ударов при приложенном пальце
    if (currentBPM > 0 && lastBeat > 0 && (now - lastBeat) > BPM_TIMEOUT_MS) {
      currentBPM = 0;
      for (byte x = 0; x < RATE_SIZE; x++) rates[x] = 0;
      rateSpot = 0;
      sendTelemetryPacket(lastSensorSampleTime, now);
    }
  } else {
    currentBPM = 0;
    currentSpO2 = 0;
  }

  // ====================================================================
  // 2. BLE: пакет ЭКГ (10 отсчетов = 40 мс) с защитой от накопления очереди
  // ====================================================================
  if (!deviceConnected) {
    ecgTail = ecgHead;
  } else {
    uint32_t head = ecgHead;
    uint32_t avail = head - ecgTail;

    // СТРОГАЯ ЗАЩИТА ОТ НАКОПЛЕНИЯ ОЧЕРЕДИ (ZERO-LAG GUARD):
    // Если буфер отстает более чем на 2 пакета (80 мс), сбрасываем хвост к реальному времени.
    // Это исключает любую задержку в передаче данных!
    if (avail > ECG_SAMPLES_PER_PKT * 2) {
      ecgOverflowCount++;
      ecgTail = head - ECG_SAMPLES_PER_PKT;
      avail = ECG_SAMPLES_PER_PKT;
    }

    if (avail >= ECG_SAMPLES_PER_PKT) {
      uint16_t samples[ECG_SAMPLES_PER_PKT];
      uint32_t t = ecgTail;
      for (uint8_t i = 0; i < ECG_SAMPLES_PER_PKT; i++) {
        samples[i] = ecgRing[(t + i) & ECG_RING_MASK];
      }
      ecgTail = t + ECG_SAMPLES_PER_PKT;

      sendPacket(samples, ECG_SAMPLES_PER_PKT, currentLeadsOff, lastSensorSampleTime, millis());
    } else if (now - lastTelemetrySentTime >= 300) {
      // Поддерживающий keepalive телеметрии (раз в 300 мс, если ЭКГ временно не сформирован)
      sendTelemetryPacket(lastSensorSampleTime, now);
    }
  }

  // ====================================================================
  // 3. ДИАГНОСТИКА (1 раз в секунду)
  // ====================================================================
  if (now - lastDiagPrintTime >= DIAG_INTERVAL_MS) {
    lastDiagPrintTime = now;
    const char* stateStr = getMeasurementStateStr(currentMeasurementState);
    const char* qualityStr = getSignalQualityStr(currentSignalQuality);
    Serial.printf("[DIAG] BLE:%s MTU:%u пак:%lu | IR=%ld RED=%ld [%s/%s] | ЧСС=%u [ударов:%lu dt=%lums raw=%.1f MaximHR=%ld (%s)] | SpO2=%u%% (буф %d/%d) | ECG=%u LO=%d\n",
                  deviceConnected ? "ON" : "OFF",
                  negotiatedMtu,
                  packetsSentCount,
                  lastIR, lastRED, stateStr, qualityStr,
                  currentBPM, totalBeatsDetected, lastBeatDeltaMs, lastRawBPM,
                  lastMaximHR, lastRejectReason,
                  currentSpO2,
                  bufFill, SPO2_BUF,
                  lastEcgSample,
                  currentLeadsOff ? 1 : 0);
  }

  // ====================================================================
  // 4. ПЕРЕЗАПУСК РЕКЛАМЫ ПОСЛЕ РАЗРЫВА
  // ====================================================================
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println("[BLE] 🔄 Реклама возобновлена.");
    oldDeviceConnected = deviceConnected;
    packetsSentCount = 0;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  delay(1);
}
