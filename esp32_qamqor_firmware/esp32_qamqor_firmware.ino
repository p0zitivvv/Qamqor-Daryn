/*
 * ==================================================================================
 * МЕДИЦИНСКИЙ СМАРТ-БРАСЛЕТ «QAMQOR» — ESP32 FULL FIRMWARE
 * Пульс + SpO2 (MAX30102) + ЭКГ 250 Гц (AD8232) -> BLE
 * ==================================================================================
 * Датчики:
 *   MAX30102 — I2C: SDA=GPIO21, SCL=GPIO22
 *   AD8232   — OUT=GPIO36 (VP), LO+=GPIO25, LO-=GPIO26
 *
 * Библиотеки (Arduino Library Manager):
 *   - "SparkFun MAX3010x Pulse and Proximity Sensor Library"
 *     (даёт MAX30105.h, heartRate.h и spo2_algorithm.h)
 *   - ESP32 BLE Arduino (входит в ядро ESP32)
 *
 * BLE:
 *   Device Name:         Qamqor_Band
 *   Service UUID:        4fafc201-1fb5-459e-8fcc-c5c9c331914b
 *   Characteristic UUID: beb5483e-36e1-4688-b7f5-ea07361b26a8
 *
 * Формат пакета (25 пакетов/сек, каждые 40 мс):
 *   {"bpm":72,"spo2":98,"lo":0,"ecg":[2048,2051,... 10 значений]}
 *   bpm  = 0 — палец не приложен
 *   spo2 = 0 — SpO2 ещё не рассчитан (первые ~4 с после касания) или сигнал плохой
 *
 * ВАЖНО: SpO2 по алгоритму Maxim — оценочный показатель для проекта/демонстрации,
 * это не медицинский прибор.
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

// --- ЭКГ (должно совпадать с ble.js: ECG_SAMPLE_RATE_HZ = 250) ---
#define ECG_SAMPLE_RATE_HZ   250
#define ECG_SAMPLE_PERIOD_MS (1000 / ECG_SAMPLE_RATE_HZ)   // 4 мс
#define ECG_SAMPLES_PER_PKT  10                            // 10 * 4 мс = 40 мс
#define ECG_RING_SIZE        256                           // степень двойки
#define ECG_RING_MASK        (ECG_RING_SIZE - 1)

// --- ПУЛЬС / SpO2 ---
#define FINGER_IR_THRESHOLD  10000    // IR ниже порога = палец не приложен
#define SPO2_BUF             100      // 4 с при 25 выб/с (100 Гц / усреднение 4)
#define SPO2_STEP            25       // пересчёт SpO2 раз в секунду
#define SPO2_AVG_N           4        // сглаживание: среднее последних валидных
#define SPO2_MIN_VALID       80
#define SPO2_MAX_VALID       100
#define SPO2_HOLD_MS         8000     // сколько держать старое значение, если новые невалидны

// --- ОБЪЕКТЫ ---
MAX30105 particleSensor;
bool max30102Present = false;

BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
BLE2902* pBLE2902 = NULL;

volatile bool deviceConnected = false;
bool oldDeviceConnected = false;
volatile uint16_t negotiatedMtu = 23;

// --- ЭКГ: кольцевой буфер (producer = ecgTask, consumer = loop) ---
volatile uint16_t ecgRing[ECG_RING_SIZE];
volatile uint32_t ecgHead = 0;
volatile uint32_t ecgTail = 0;
volatile bool currentLeadsOff = false;
volatile uint16_t lastEcgSample = 2048;

// --- ПУЛЬС ---
uint8_t currentBPM = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE] = {0, 0, 0, 0};
byte rateSpot = 0;
long lastIR = 0;
const unsigned long BPM_TIMEOUT_MS = 8000;

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
bool fingerWasOn = false;

// --- ДИАГНОСТИКА ---
unsigned long lastDiagPrintTime = 0;
const unsigned long DIAG_INTERVAL_MS = 1000;
unsigned long packetsSentCount = 0;
unsigned long packetsFailedCount = 0;
unsigned long ecgOverflowCount = 0;

// --- BLE CALLBACKS ---
class QamqorServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) {
    deviceConnected = true;
    negotiatedMtu = 23;
    Serial.println("\n[BLE] ✅ КЛИЕНТ ПОДКЛЮЧЕН");
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
// SpO2: сброс и расчёт
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
}

void computeSpO2(unsigned long now) {
  maxim_heart_rate_and_oxygen_saturation(irBuf, SPO2_BUF, redBuf,
                                         &spo2Raw, &spo2Valid, &hrRaw, &hrValid);

  if (spo2Valid && spo2Raw >= SPO2_MIN_VALID && spo2Raw <= SPO2_MAX_VALID) {
    spo2Hist[spo2HistPos] = (uint8_t)spo2Raw;
    spo2HistPos = (spo2HistPos + 1) % SPO2_AVG_N;
    if (spo2HistCount < SPO2_AVG_N) spo2HistCount++;

    int sum = 0;
    for (uint8_t i = 0; i < spo2HistCount; i++) sum += spo2Hist[i];
    currentSpO2 = (uint8_t)(sum / spo2HistCount);
    lastSpo2ValidTime = now;
  } else if (lastSpo2ValidTime > 0 && (now - lastSpo2ValidTime) > SPO2_HOLD_MS) {
    // Давно нет валидных расчётов — не показываем устаревшее значение
    currentSpO2 = 0;
    spo2HistCount = 0;
    spo2HistPos = 0;
  }
}

void processPulseOxSample(uint32_t ir, uint32_t red, unsigned long now) {
  lastIR = ir;

  if (ir < FINGER_IR_THRESHOLD) {
    // Палец убран
    if (fingerWasOn) {
      resetPulseOx();
      fingerWasOn = false;
    }
    return;
  }
  fingerWasOn = true;

  // --- ЧСС по детектору ударов (быстрый отклик) ---
  if (checkForBeat((long)ir)) {
    long delta = now - lastBeat;
    lastBeat = now;

    if (delta > 0) {
      beatsPerMinute = 60.0 / (delta / 1000.0);

      if (beatsPerMinute >= 40 && beatsPerMinute <= 200) {
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
// ОТПРАВКА ПАКЕТА (с нарезкой по MTU, если MTU не согласован)
// =====================================================================
void sendPacket(const uint16_t* samples, uint8_t count, bool lo) {
  char payload[160];
  int n = snprintf(payload, sizeof(payload),
                   "{\"bpm\":%u,\"spo2\":%u,\"lo\":%d,\"ecg\":[",
                   currentBPM, currentSpO2, lo ? 1 : 0);

  for (uint8_t i = 0; i < count; i++) {
    n += snprintf(payload + n, sizeof(payload) - n, i ? ",%u" : "%u", samples[i]);
  }
  n += snprintf(payload + n, sizeof(payload) - n, "]}");

  uint16_t chunk = negotiatedMtu > 3 ? negotiatedMtu - 3 : 20;
  if (chunk > 512) chunk = 512;

  if (n <= chunk) {
    pCharacteristic->setValue((uint8_t*)payload, n);
    pCharacteristic->notify();
  } else {
    for (int off = 0; off < n; off += chunk) {
      int len = min((int)chunk, n - off);
      pCharacteristic->setValue((uint8_t*)(payload + off), len);
      pCharacteristic->notify();
      delay(3);
    }
  }
  packetsSentCount++;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n*** QAMQOR BAND FULL — ЧСС + SpO2 + ЭКГ 250 Hz ***");

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
    // Параметры как в SparkFun Example8_SPO2 (под алгоритм Maxim, 25 выб/с)
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
  BLEDevice::setMTU(247);   // до init()
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

  // 4. Задача ЭКГ на ядре 1, приоритет выше loop()
  xTaskCreatePinnedToCore(ecgTask, "ecg250", 4096, NULL, 2, NULL, 1);
  Serial.println("✅ [ECG] Задача 250 Гц запущена.");
}

void loop() {
  unsigned long now = millis();

  // ====================================================================
  // 1. MAX30102: пульс + SpO2 (без блокировок, читаем весь FIFO)
  // ====================================================================
  if (max30102Present) {
    particleSensor.check();

    while (particleSensor.available()) {
      uint32_t ir  = particleSensor.getFIFOIR();
      uint32_t red = particleSensor.getFIFORed();
      particleSensor.nextSample();
      processPulseOxSample(ir, red, now);
    }

    // Нет ударов дольше таймаута — не показываем устаревший пульс
    if (currentBPM > 0 && lastBeat > 0 && (now - lastBeat) > BPM_TIMEOUT_MS) {
      currentBPM = 0;
      for (byte x = 0; x < RATE_SIZE; x++) rates[x] = 0;
      rateSpot = 0;
    }
  } else {
    currentBPM = 0;
    currentSpO2 = 0;
  }

  // ====================================================================
  // 2. BLE: пакет на каждые 10 накопленных отсчётов ЭКГ (40 мс)
  // ====================================================================
  if (!deviceConnected) {
    ecgTail = ecgHead;
  } else {
    uint32_t head = ecgHead;
    uint32_t avail = head - ecgTail;

    if (avail > ECG_RING_SIZE - ECG_SAMPLES_PER_PKT) {
      ecgOverflowCount++;
      ecgTail = head - ECG_SAMPLES_PER_PKT;
      avail = ECG_SAMPLES_PER_PKT;
    }

    uint8_t guard = 0;
    while (avail >= ECG_SAMPLES_PER_PKT && guard < 2) {
      uint16_t samples[ECG_SAMPLES_PER_PKT];
      uint32_t t = ecgTail;
      for (uint8_t i = 0; i < ECG_SAMPLES_PER_PKT; i++) {
        samples[i] = ecgRing[(t + i) & ECG_RING_MASK];
      }
      ecgTail = t + ECG_SAMPLES_PER_PKT;
      avail -= ECG_SAMPLES_PER_PKT;
      guard++;

      sendPacket(samples, ECG_SAMPLES_PER_PKT, currentLeadsOff);
    }
  }

  // ====================================================================
  // 3. ДИАГНОСТИКА (1 раз в секунду)
  // ====================================================================
  if (now - lastDiagPrintTime >= DIAG_INTERVAL_MS) {
    lastDiagPrintTime = now;
    const char* pulseState = !max30102Present ? "ДАТЧИК_ОТКЛ" :
                             (lastIR >= FINGER_IR_THRESHOLD ? "ПАЛЕЦ_ОК" : "НЕТ_ПАЛЬЦА");
    Serial.printf("[DIAG] BLE:%s MTU:%u пак:%lu err:%lu ovf:%lu | IR=%ld [%s] ЧСС=%u SpO2=%u%% (буфер %d/%d) | ECG=%u LO=%d\n",
                  deviceConnected ? "ON" : "OFF",
                  negotiatedMtu,
                  packetsSentCount,
                  packetsFailedCount,
                  ecgOverflowCount,
                  lastIR, pulseState,
                  currentBPM, currentSpO2,
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
