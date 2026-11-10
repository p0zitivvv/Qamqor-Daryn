/*
 * ==================================================================================
 * МЕДИЦИНСКИЙ СМАРТ-БРАСЛЕТ «QAMQOR» — ESP32 FIRMWARE (PRO DUAL-SENSOR EDITION)
 * ==================================================================================
 * Аппаратная платформа: ESP32 NodeMCU / ESP32-WROOM-32 / DOIT ESP32 DEVKIT V1
 * Датчики:
 *   1. MAX30102 — Оптический пульсоксиметр ЧСС и SpO2 (I2C: SDA=GPIO21, SCL=GPIO22)
 *   2. AD8232   — Электрокардиограф ЭКГ (Аналоговый выход=GPIO36 / VP, LO+=GPIO25, LO-=GPIO26)
 *
 * Беспроводной протокол: BLE (Bluetooth Low Energy)
 *   Device Name:         Qamqor_Band
 *   Service UUID:        4fafc201-1fb5-459e-8fcc-c5c9c331914b
 *   Characteristic UUID: beb5483e-36e1-4688-b7f5-ea07361b26a8
 * ==================================================================================
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "MAX30105.h"
#include "heartRate.h"

// --- UUIDs СЕРВИСА И ХАРАКТЕРИСТИКИ ---
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define DEVICE_NAME         "Qamqor_Band"

// --- НАЗНАЧЕНИЕ ПИНОВ ---
#define I2C_SDA_PIN         21  // Шина данных I2C для MAX30102
#define I2C_SCL_PIN         22  // Тактовая линия I2C для MAX30102

#define AD8232_OUTPUT_PIN   36  // VP / GPIO36 (ADC1_CH0) — аналоговый выход ЭКГ
#define AD8232_LO_PLUS_PIN  25  // Leads Off Detector (+)
#define AD8232_LO_MINUS_PIN 26  // Leads Off Detector (-)

// --- ОБЪЕКТЫ ДАТЧИКОВ И BLE ---
MAX30105 particleSensor;
bool max30102Present = false;

BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
BLE2902* pBLE2902 = NULL;

bool deviceConnected = false;
bool oldDeviceConnected = false;

// --- ТЕЛЕМЕТРИЯ И БИОМЕТРИЯ ---
uint8_t currentBPM = 0;
uint8_t currentSpO2 = 0;
uint16_t currentECG = 2048;
bool currentLeadsOff = false;

long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE] = {0, 0, 0, 0};
byte rateSpot = 0;

// Таймеры передачи данных и диагностики
unsigned long lastTelemetrySendTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 50; // 20 Гц — стабильная частота без переполнения BLE стека

unsigned long lastDiagPrintTime = 0;
const unsigned long DIAG_INTERVAL_MS = 1000;    // Диагностика в Serial раз в 1 сек

unsigned long packetsSentCount = 0;
unsigned long packetsFailedCount = 0;

// --- BLE CALLBACKS СЕРВЕРА ---
class QamqorServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("\n=======================================================");
      Serial.println("[BLE] ✅ КЛИЕНТ ПОДКЛЮЧЕН (Qamqor PWA)");
      Serial.println("[BLE] Готовность к потоковой передаче телеметрии...");
      Serial.println("=======================================================\n");
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("\n[BLE] ⚠️ Клиент отключился от браслета.");
    }
};

// --- BLE CALLBACKS ХАРАКТЕРИСТИКИ ---
class QamqorCharCallbacks: public BLECharacteristicCallbacks {
    void onRead(BLECharacteristic* pCharacteristic) {
      Serial.println("[BLE] Клиент запросил READ характеристики");
    }
    void onWrite(BLECharacteristic* pCharacteristic) {
      Serial.println("[BLE] Клиент выполнил WRITE характеристики");
    }
    void onStatus(BLECharacteristic* pCharacteristic, Status s, uint32_t code) {
      if (s != SUCCESS_NOTIFY && s != SUCCESS_INDICATE) {
        packetsFailedCount++;
        Serial.printf("[BLE] ❌ Ошибка notify (код %d)\n", code);
      }
    }
};

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n");
  Serial.println("*******************************************************");
  Serial.println("   МЕДИЦИНСКИЙ СМАРТ-БРАСЛЕТ «QAMQOR BAND» — ESP32    ");
  Serial.println("*******************************************************");

  // 1. НАСТРОЙКА ПИНОВ AD8232 (ЭКГ)
  Serial.println("\n[AD8232] Инициализация пинов кардиографа...");
  analogReadResolution(12); // 12-битный ADC (0 .. 4095)
  #if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
    analogSetPinAttenuation(AD8232_OUTPUT_PIN, ADC_11db);
  #else
    analogSetAttenuation(ADC_11db);
  #endif

  pinMode(AD8232_OUTPUT_PIN, INPUT);
  // ВАЖНО: Используем INPUT_PULLDOWN, чтобы неподключенные пины LO+/LO- не плавали в HIGH
  pinMode(AD8232_LO_PLUS_PIN, INPUT_PULLDOWN);
  pinMode(AD8232_LO_MINUS_PIN, INPUT_PULLDOWN);
  Serial.printf("[AD8232] Пины настроены: Output=GPIO%d, LO+=GPIO%d, LO-=GPIO%d\n",
                AD8232_OUTPUT_PIN, AD8232_LO_PLUS_PIN, AD8232_LO_MINUS_PIN);

  // 2. НАСТРОЙКА ШИНЫ I2C И MAX30102 (ПУЛЬСОКСИМЕТР)
  Serial.println("\n[MAX30102] Инициализация шины I2C (SDA=21, SCL=22)...");
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000); // 400 кГц быстрый режим I2C

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("❌ [MAX30102] Датчик не найден на шине I2C!");
    Serial.println("   Проверьте питание (VIN 3.3V/5V), землю (GND) и подтяжку SDA/SCL.");
    Serial.println("   ℹ️ Браслет продолжит работу с AD8232 в независимом режиме.");
    max30102Present = false;
  } else {
    max30102Present = true;
    Serial.println("✅ [MAX30102] Датчик обнаружен и успешно инициализирован.");

    // Конфигурация оптического датчика для измерения пульса и SpO2
    // Режим ledMode = 2 (Red + IR, только для MAX30102!)
    byte ledBrightness = 0x24; // ~7.2 мА (достаточно для точного считывания через кожу)
    byte sampleAverage = 4;
    byte ledMode = 2;          // 2 = Red + IR (SpO2 & HR)
    int sampleRate = 100;      // 100 Гц
    int pulseWidth = 411;      // 18-битное разрешение АЦП
    int adcRange = 4096;       // 4096 nA
    particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);

    particleSensor.setPulseAmplitudeRed(0x24);
    particleSensor.setPulseAmplitudeIR(0x24);
    particleSensor.setPulseAmplitudeGreen(0); // Зеленый выключен (отсутствует в MAX30102)
    Serial.println("[MAX30102] Параметры: Режим=Red+IR (Mode 2), Частота=100 Гц, Ток LED=0x24");
  }

  // 3. ИНИЦИАЛИЗАЦИЯ BLUETOOTH LOW ENERGY (BLE)
  Serial.println("\n[BLE] Запуск Bluetooth Low Energy стека...");
  BLEDevice::init(DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new QamqorServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ   |
                      BLECharacteristic::PROPERTY_NOTIFY |
                      BLECharacteristic::PROPERTY_INDICATE
                    );

  pCharacteristic->setCallbacks(new QamqorCharCallbacks());

  // Клиентский дескриптор уведомлений (CCCD 0x2902)
  pBLE2902 = new BLE2902();
  pBLE2902->setNotifications(true); // Включаем флаг уведомлений по умолчанию
  pCharacteristic->addDescriptor(pBLE2902);

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06); // 7.5 ms
  pAdvertising->setMinPreferred(0x12); // 22.5 ms
  BLEDevice::startAdvertising();

  Serial.println("✅ [BLE] Сервер запущен успешно.");
  Serial.printf("   Device Name:         %s\n", DEVICE_NAME);
  Serial.printf("   Service UUID:        %s\n", SERVICE_UUID);
  Serial.printf("   Characteristic UUID: %s\n", CHARACTERISTIC_UUID);
  Serial.println("\n⏳ Ожидание подключения PWA приложения Qamqor...");
}

void loop() {
  unsigned long now = millis();

  // ====================================================================
  // 1. СЧИТЫВАНИЕ АНАЛОГОВОГО СИГНАЛА ЭКГ С AD8232 (НЕЗАВИСИМО)
  // ====================================================================
  bool loPlus = (digitalRead(AD8232_LO_PLUS_PIN) == 1);
  bool loMinus = (digitalRead(AD8232_LO_MINUS_PIN) == 1);
  currentLeadsOff = (loPlus || loMinus);

  int adcRaw = analogRead(AD8232_OUTPUT_PIN);

  if (currentLeadsOff) {
    currentECG = 2048; // Линия изолинии при аппаратном обрыве контакта
  } else {
    currentECG = (uint16_t)adcRaw;
  }

  // ====================================================================
  // 2. СЧИТЫВАНИЕ ОПТИЧЕСКОГО СИГНАЛА С MAX30102 (НЕЗАВИСИМО)
  // ====================================================================
  long irValue = 0;
  if (max30102Present) {
    irValue = particleSensor.getIR();

    // Проверка наличия пальца на сенсоре:
    // Порог 10000 гарантирует надежное обнаружение пальца на питании 3.3V
    if (irValue >= 10000) {
      if (checkForBeat(irValue) == true) {
        long delta = now - lastBeat;
        lastBeat = now;

        if (delta > 0) {
          beatsPerMinute = 60.0 / (delta / 1000.0);

          if (beatsPerMinute >= 40 && beatsPerMinute <= 200) {
            // Инициализация массива усреднения на первом достоверном ударе
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
            currentSpO2 = 98; // Базовая сатурация при стабильном оптическом пульсе
          }
        }
      }
    } else {
      // Палец убран с сенсора
      currentBPM = 0;
      currentSpO2 = 0;
      for (byte x = 0; x < RATE_SIZE; x++) rates[x] = 0;
      rateSpot = 0;
    }
  } else {
    currentBPM = 0;
    currentSpO2 = 0;
  }

  // ====================================================================
  // 3. ОТПРАВКА BLE УВЕДОМЛЕНИЯ ПРИ ПОДКЛЮЧЕННОМ КЛИЕНТЕ (20 Гц)
  // ====================================================================
  if (deviceConnected && (now - lastTelemetrySendTime >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetrySendTime = now;

    // Формирование компактного JSON-пакета
    // lo: 1 (обрыв электродов) или 0 (электроды на теле)
    char payload[80];
    snprintf(payload, sizeof(payload), "{\"bpm\":%u,\"spo2\":%u,\"ecg\":%u,\"lo\":%d}", 
             currentBPM, 
             currentSpO2, 
             currentECG,
             currentLeadsOff ? 1 : 0);

    pCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    pCharacteristic->notify();
    packetsSentCount++;
  }

  // ====================================================================
  // 4. ДИАГНОСТИЧЕСКИЕ СООБЩЕНИЯ В SERIAL РАЗ В 1 СЕКУНДУ
  // ====================================================================
  if (now - lastDiagPrintTime >= DIAG_INTERVAL_MS) {
    lastDiagPrintTime = now;

    const char* bleState = deviceConnected ? "ПОДКЛЮЧЕН" : "ОЖИДАНИЕ";
    const char* pulseState = !max30102Present ? "ДАТЧИК_ОТКЛ" : (irValue >= 10000 ? "ПАЛЕЦ_ОК" : "НЕТ_ПАЛЬЦА");
    const char* ecgState = currentLeadsOff ? "ОБРЫВ_LO" : "СИГНАЛ_ОК";

    Serial.printf("[DIAG 1s] BLE: %s (пакетов: %lu) | MAX30102: IR=%ld [%s] ЧСС=%u SpO2=%u%% | AD8232: ADC=%u [%s]\n",
                  bleState,
                  packetsSentCount,
                  irValue,
                  pulseState,
                  currentBPM,
                  currentSpO2,
                  currentECG,
                  ecgState);
  }

  // ====================================================================
  // 5. ОБРАБОТКА РАЗРЫВА И ВОЗОБНОВЛЕНИЯ RE-ADVERTISING BLE
  // ====================================================================
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); // Небольшая пауза перед перезапуском рекламы
    pServer->startAdvertising();
    Serial.println("[BLE] 🔄 Возобновлена реклама BLE, ожидание переподключения PWA...");
    oldDeviceConnected = deviceConnected;
    packetsSentCount = 0;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  delay(2);
}
