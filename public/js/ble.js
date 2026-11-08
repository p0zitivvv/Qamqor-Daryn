/**
 * Qamqor Health Monitoring System
 * Модуль интеграции с Web Bluetooth API (BLE Layer)
 * Реализация спецификации раздела 1.2, 7, 12.1
 */

import { MODEL_CONFIG } from './config.js';
import { validatePulseOximetry, RPeakDetector, checkECGSignalQuality } from './signals.js';

export class BLEService {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.isConnected = false;
    this.deviceName = 'Qamqor Band';
    
    // Внутренний обработчик R-пиков ЭКГ для реального времени
    this.rPeakDetector = new RPeakDetector(25); // 25 Гц частота опроса ESP32

    // Коллбеки
    this.onTelemetry = null; // ({ bpm, spo2, ecg, rPeak, instantaneousBpm, timestamp })
    this.onStatusChange = null; // ({ connected, deviceName, statusText })
    this.onError = null;
  }

  isSupported() {
    return 'bluetooth' in navigator;
  }

  isSecureContext() {
    return window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  }

  async connect() {
    if (!this.isSupported()) {
      throw new Error('Ваш браузер не поддерживает Web Bluetooth API. Используйте Chrome, Edge или Bluefy на iOS.');
    }
    if (!this.isSecureContext()) {
      throw new Error('Web Bluetooth требует защищенного соединения HTTPS или localhost.');
    }

    try {
      const { serviceUuid, characteristicUuid, deviceName } = MODEL_CONFIG.ble;

      // 1. Поиск устройства
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: deviceName },
          { namePrefix: 'Qamqor' }
        ],
        optionalServices: [serviceUuid]
      });

      this.deviceName = this.device.name || 'Qamqor_Band';
      this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnected());

      // 2. Подключение к серверу GATT
      this.server = await this.device.gatt.connect();

      // 3. Получение службы и характеристики
      const service = await this.server.getPrimaryService(serviceUuid);
      this.characteristic = await service.getCharacteristic(characteristicUuid);
      // 4. Подписка на уведомления
      await this.characteristic.startNotifications();
      this.characteristic.addEventListener('characteristicvaluechanged', (e) => this.handlePacket(e));

      this.isConnected = true;
      if (this.onStatusChange) {
        this.onStatusChange({
          connected: true,
          deviceName: this.deviceName,
          statusText: 'Подключено по BLE'
        });
      }

      return this.deviceName;
    } catch (err) {
      this.isConnected = false;
      if (this.onError) this.onError(err);
      throw err;
    }
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.isConnected = false;
  }

  handleDisconnected() {
    this.isConnected = false;
    this.rPeakDetector.reset();
    if (this.onStatusChange) {
      this.onStatusChange({
        connected: false,
        deviceName: this.deviceName,
        statusText: 'Связь с браслетом потеряна'
      });
    }
  }

  handlePacket(event) {
    try {
      const dataView = event.target.value;
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(dataView).trim();
      const now = Date.now();

      let bpm = null;
      let spo2 = null;
      let ecg = null;

      // 1. Парсинг формата JSON: {"bpm":72,"spo2":98,"ecg":2048}
      if (text.startsWith('{') && text.endsWith('}')) {
        const json = JSON.parse(text);
        bpm = json.bpm;
        spo2 = json.spo2;
        ecg = json.ecg;
      } else if (text.includes(',') || text.includes(':')) {
        // Формат CSV/Key-Value
        const parts = text.split(',');
        parts.forEach(p => {
          const pair = p.split(':');
          if (pair.length === 2) {
            const k = pair[0].trim().toUpperCase();
            const v = parseFloat(pair[1]);
            if (k === 'BPM') bpm = v;
            if (k === 'SPO2') spo2 = v;
            if (k === 'ECG') ecg = v;
          }
        });
      } else if (dataView.byteLength >= 4) {
        // Двоичный формат
        bpm = dataView.getUint8(0);
        spo2 = dataView.getUint8(1);
        ecg = dataView.getUint16(2, false);
      }

      // 2. Валидация пульса и SpO2
      const pulseValidation = validatePulseOximetry(bpm, spo2);

      // 3. Обработка отсчета ЭКГ через детектор R-пиков
      let peakResult = null;
      let ecgQuality = null;

      if (typeof ecg === 'number') {
        ecgQuality = checkECGSignalQuality(ecg, false);
        if (ecgQuality.isValid) {
          peakResult = this.rPeakDetector.processSample(ecg, now);
        }
      }

      // 4. Определение активности реальных датчиков
      const hasActivePulse = pulseValidation && pulseValidation.isValid && pulseValidation.bpm > 0;
      const hasActiveECG = typeof ecg === 'number' && ecg > 10 && ecg < 4085 && ecg !== 2048;
      const hasValidSensors = hasActivePulse || hasActiveECG;

      if (this.onTelemetry) {
        this.onTelemetry({
          bpm: pulseValidation.isValid ? pulseValidation.bpm : null,
          spo2: pulseValidation.isValid ? pulseValidation.spo2 : null,
          rawBpm: bpm,
          rawSpO2: spo2,
          ecg: (hasActiveECG && typeof ecg === 'number') ? ecg : null,
          pulseValidation,
          ecgQuality,
          hasValidSensors,
          hasActivePulse,
          hasActiveECG,
          rPeak: peakResult ? peakResult.peakDetected : false,
          instantaneousBpm: peakResult ? peakResult.instantaneousBpm : null,
          rrIntervals: this.rPeakDetector.getValidRRIntervals(),
          timestamp: now
        });
      }
    } catch (err) {
      console.warn('BLE Packet parse warning:', err);
    }
  }
}
