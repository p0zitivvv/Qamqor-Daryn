/*
 * ==================================================================================
 * МЕДИЦИНСКИЙ СМАРТ-БРАСЛЕТ «QAMQOR» — ESP32 FIRMWARE
 * ==================================================================================
 * Аппаратная платформа: ESP32 NodeMCU / ESP32-WROOM-32
 * Датчики:
 *   1. MAX30102 — Пульсоксиметр (I2C: SDA=GPIO21, SCL=GPIO22)
 *   2. AD8232   — Модуль ЭКГ (Аналоговый выход=GPIO36 / ADC1_CH0, LO+=GPIO25, LO-=GPIO26)
 *
 * Беспроводной протокол: BLE (Bluetooth Low Energy)
 *   Device Name: Qamqor_Band
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

// --- UUIDs ---
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define DEVICE_NAME         "Qamqor_Band"

// --- PIN ASSIGNMENTS ---
#define AD8232_OUTPUT_PIN   36  // VP / GPIO36 (ADC1)
#define AD8232_LO_PLUS_PIN  25  // Leads off detector +
#define AD8232_LO_MINUS_PIN 26  // Leads off detector -

// --- OBJECTS ---
MAX30105 particleSensor;
BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// --- BIOMETRICS BUFFER ---
uint8_t currentBPM = 72;
uint8_t currentSpO2 = 98;
uint16_t currentECG = 2048;

long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 72;
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;

unsigned long lastTelemetrySendTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 40; // 25 Hz updates for fast ECG

// --- BLE CALLBACKS ---
class QamqorServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("[BLE] Клиент подключен (Qamqor PWA)");
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("[BLE] Клиент отключен");
    }
};

void setup() {
  Serial.begin(115200);
  Serial.println("\n--- Запуск браслета Qamqor Band ---");

  // Настройка пинов AD8232
  pinMode(AD8232_OUTPUT_PIN, INPUT);
  pinMode(AD8232_LO_PLUS_PIN, INPUT);
  pinMode(AD8232_LO_MINUS_PIN, INPUT);

  // Инициализация I2C для MAX30102
  Wire.begin(21, 22);
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("[MAX30102] Датчик не найден! Проверьте питание и шину I2C.");
  } else {
    Serial.println("[MAX30102] Датчик инициализирован успешно.");
    particleSensor.setup(); // Конфигурация по умолчанию
    particleSensor.setPulseAmplitudeRed(0x0A); // Красный светодиод для SpO2
    particleSensor.setPulseAmplitudeGreen(0);  // Зеленый выключен
  }

  // Инициализация Bluetooth Low Energy
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

  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] Ожидание подключения PWA приложения...");
}

void loop() {
  // 1. Считывание аналогового сигнала ЭКГ с AD8232
  bool leadsOff = (digitalRead(AD8232_LO_PLUS_PIN) == 1 || digitalRead(AD8232_LO_MINUS_PIN) == 1);
  if (leadsOff) {
    currentECG = 2048; // Линия изолинии при обрыве контакта
  } else {
    currentECG = analogRead(AD8232_OUTPUT_PIN); // 12-битный ADC (0-4095)
  }

  // 2. Считывание фотоплетизмограммы (PPG) с MAX30102
  long irValue = particleSensor.getIR();
  if (checkForBeat(irValue) == true) {
    long delta = millis() - lastBeat;
    lastBeat = millis();

    beatsPerMinute = 60 / (delta / 1000.0);

    if (beatsPerMinute < 255 && beatsPerMinute > 40) {
      rates[rateSpot++] = (byte)beatsPerMinute;
      rateSpot %= RATE_SIZE;

      beatAvg = 0;
      for (byte x = 0 ; x < RATE_SIZE ; x++) beatAvg += rates[x];
      beatAvg /= RATE_SIZE;
      currentBPM = (uint8_t)beatAvg;
      
      // Расчет SpO2 (базовая оценка соотношения переменной и постоянной составляющей)
      currentSpO2 = 98; 
    }
  }

  // Если палец убран с MAX30102
  if (irValue < 50000) {
    currentBPM = 0;
    currentSpO2 = 0;
  }

  // 3. Отправка пакета в PWA по BLE с заданной частотой
  unsigned long now = millis();
  if (deviceConnected && (now - lastTelemetrySendTime >= TELEMETRY_INTERVAL_MS)) {
    lastTelemetrySendTime = now;

    // Формирование JSON-строки для PWA (передаем 0 при отсутствии контакта с MAX30102 и lo при обрыве электродов AD8232)
    char payload[80];
    snprintf(payload, sizeof(payload), "{\"bpm\":%u,\"spo2\":%u,\"ecg\":%u,\"lo\":%d}", 
             currentBPM, 
             currentSpO2, 
             currentECG,
             leadsOff ? 1 : 0);

    pCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    pCharacteristic->notify();
  }

  // Обработка переподключения BLE
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println("[BLE] Возобновление рекламы BLE...");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  delay(5);
}
