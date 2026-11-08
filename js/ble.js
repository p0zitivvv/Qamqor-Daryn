/**
 * Qamqor Health Monitoring System
 * BLE Service — ESP32 + MAX30102
 *
 * Device: Qamqor_Band
 * Service UUID:
 * 4fafc201-1fb5-459e-8fcc-c5c9c331914b
 *
 * Characteristic UUID:
 * beb5483e-36e1-4688-b7f5-ea07361b26a8
 */

import { MODEL_CONFIG } from './config.js';
import {
  validatePulseOximetry,
  RPeakDetector,
  checkECGSignalQuality
} from './signals.js';

export class BLEService {

  constructor() {

    this.device = null;
    this.server = null;
    this.characteristic = null;

    this.isConnected = false;
    this.userRequestedDisconnect = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimer = null;
    this.connectionStartTime = null;

    this.deviceName = 'Qamqor_Band';

    this.rPeakDetector = new RPeakDetector(25);

    this.onTelemetry = null;
    this.onStatusChange = null;
    this.onError = null;

    this.lastPacketTime = null;
    this.lastValidMeasurement = null;

    this.packetCount = 0;
    this.packetBuffer = '';

    this.status = 'disconnected';

    this.handleCharacteristicChange =
      this.handlePacket.bind(this);

    this.handleDisconnectEvent =
      this.handleDisconnected.bind(this);

    if (typeof window !== 'undefined') {
      window.__qamqor_ble_service = this;
    }
  }

  // =========================================
  // BROWSER SUPPORT
  // =========================================

  isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      'bluetooth' in navigator
    );
  }

  isSecureContext() {
    return (
      typeof window !== 'undefined' &&
      (window.isSecureContext ||
       window.location.hostname === 'localhost' ||
       window.location.hostname === '127.0.0.1')
    );
  }

  // =========================================
  // STATUS MANAGEMENT
  // =========================================

  updateStatus(status, statusText) {

    this.status = status;

    if (this.onStatusChange) {

      this.onStatusChange({
        connected: this.isConnected,
        deviceName: this.deviceName,
        status,
        statusText
      });
    }
  }

  emitEmptyTelemetry(status) {

    this.rPeakDetector.reset();

    this.lastValidMeasurement = null;

    if (this.onTelemetry) {

      this.onTelemetry({

        bpm: null,
        spo2: null,

        rawBpm: null,
        rawSpO2: null,

        ecg: null,
        ecgQuality: null,

        pulseValidation: {
          isValid: false,
          bpm: null,
          spo2: null
        },

        hasValidSensors: false,
        hasActivePulse: false,
        hasActiveECG: false,

        rPeak: false,
        instantaneousBpm: null,

        rrIntervals: [],

        timestamp: Date.now(),

        status
      });
    }
  }

  // =========================================
  // CONNECT
  // =========================================

  async connect() {

    if (!this.isSecureContext()) {
      const err = new Error('Для работы Web Bluetooth требуется безопасное HTTPS-соединение или localhost.');
      console.error('[QAMQOR BLE]', err.message);
      throw err;
    }

    if (!this.isSupported()) {
      const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent || '');
      const err = isIOS
        ? new Error('Safari на iPhone не поддерживает Web Bluetooth API. Откройте приложение через браузер Bluefy из App Store.')
        : new Error('Ваш браузер не поддерживает Web Bluetooth API. Используйте Google Chrome или Microsoft Edge.');
      console.error('[QAMQOR BLE]', err.message);
      throw err;
    }

    this.userRequestedDisconnect = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;

    try {

      const {
        serviceUuid,
        characteristicUuid
      } = MODEL_CONFIG.ble;

      console.log(`[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Запрос устройства Web Bluetooth...`);

      const device = await navigator.bluetooth.requestDevice({

        filters: [
          { name: 'Qamqor_Band' },
          { name: 'Qamqor Band' },
          { namePrefix: 'Qamqor' }
        ],

        optionalServices: [
          serviceUuid
        ]
      });

      this.device = device;
      this.deviceName = device.name || 'Qamqor_Band';

      // Снимаем старый слушатель перед добавлением
      this.device.removeEventListener(
        'gattserverdisconnected',
        this.handleDisconnectEvent
      );
      this.device.addEventListener(
        'gattserverdisconnected',
        this.handleDisconnectEvent
      );

      console.log(`[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Подключение к GATT серверу ${this.deviceName}...`);

      this.server = await device.gatt.connect();

      const service =
        await this.server.getPrimaryService(serviceUuid);

      this.characteristic =
        await service.getCharacteristic(characteristicUuid);

      await this.characteristic.startNotifications();

      // Снимаем старый слушатель перед добавлением
      this.characteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handleCharacteristicChange
      );
      this.characteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleCharacteristicChange
      );

      // Глобальная привязка к window для предотвращения GC
      if (typeof window !== 'undefined') {
        window.__qamqor_ble_device = this.device;
        window.__qamqor_ble_server = this.server;
        window.__qamqor_ble_char = this.characteristic;
      }

      this.isConnected = true;
      this.isReconnecting = false;
      this.connectionStartTime = Date.now();
      this.lastPacketTime = Date.now();

      this.emitEmptyTelemetry('connected_no_data');

      this.updateStatus(
        'connected_no_data',
        'Подключено. Ожидание данных датчика'
      );

      console.log(
        `[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Подключено успешно:`,
        this.deviceName
      );

      return this.deviceName;

    } catch (error) {

      this.isConnected = false;

      this.updateStatus(
        'disconnected',
        'Не удалось подключиться'
      );

      console.error(
        '[QAMQOR BLE] Connection error:',
        error
      );

      if (this.onError) {
        this.onError(error);
      }

      throw error;
    }
  }

  // =========================================
  // DISCONNECT & RECONNECT MANAGEMENT
  // =========================================

  disconnect() {

    this.userRequestedDisconnect = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;

    const durSec = this.connectionStartTime ? Math.round((Date.now() - this.connectionStartTime) / 1000) : 0;
    console.log(`[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Пользователь нажал «Отключить». Длительность сессии: ${durSec} сек.`);

    if (this.characteristic) {
      try {
        this.characteristic.removeEventListener('characteristicvaluechanged', this.handleCharacteristicChange);
      } catch (e) {}
    }

    if (this.device && this.device.gatt && this.device.gatt.connected) {
      try {
        this.device.gatt.disconnect();
      } catch (e) {
        console.warn('[QAMQOR BLE] Ошибка при вызове gatt.disconnect():', e);
        this.handleDisconnected();
      }
    } else {
      this.handleDisconnected();
    }
  }

  handleDisconnected(event) {

    const isUserAction = this.userRequestedDisconnect;
    const durSec = this.connectionStartTime ? Math.round((Date.now() - this.connectionStartTime) / 1000) : 0;
    const timeStr = new Date().toLocaleTimeString('ru-RU');

    console.warn(`[QAMQOR BLE] [${timeStr}] Событие gattserverdisconnected. Причина: ${isUserAction ? 'Пользовательское отключение' : 'Неожиданный разрыв BLE соединения'}. Сессия длилась: ${durSec} сек.`);

    this.isConnected = false;
    this.server = null;
    this.characteristic = null;
    this.connectionStartTime = null;
    this.lastPacketTime = null;
    this.packetBuffer = '';
    this.packetCount = 0;

    this.emitEmptyTelemetry('disconnected');

    if (isUserAction) {
      this.userRequestedDisconnect = false;
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;
      this.updateStatus(
        'disconnected',
        'Связь с браслетом отключена'
      );
      return;
    }

    // Неожиданный разрыв связи: запускаем автопереподключение к this.device
    this.updateStatus(
      'reconnecting',
      'Соединение потеряно, переподключаюсь...'
    );
    this.attemptAutoReconnect();
  }

  attemptAutoReconnect() {

    if (this.userRequestedDisconnect || !this.device) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Исчерпаны все ${this.maxReconnectAttempts} попыток переподключения.`);
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.updateStatus(
        'disconnected',
        'Связь потеряна. Нажмите «Подключить», чтобы восстановить связь.'
      );
      if (this.onError) {
        this.onError(new Error('Связь с браслетом потеряна (5 попыток переподключения завершились неудачно)'));
      }
      return;
    }

    this.reconnectAttempts++;
    this.isReconnecting = true;

    // Экспоненциальная задержка: 1.5s, 3s, 6s, 12s, 24s
    const delayMs = Math.min(24000, Math.round(1500 * Math.pow(2, this.reconnectAttempts - 1)));
    console.warn(`[QAMQOR BLE] Попытка переподключения ${this.reconnectAttempts} из ${this.maxReconnectAttempts} через ${delayMs / 1000} сек...`);
    this.updateStatus(
      'reconnecting',
      `Соединение потеряно, переподключаюсь (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(async () => {
      if (this.userRequestedDisconnect) return;
      try {
        await this.reconnectToExistingDevice();
      } catch (err) {
        console.warn(`[QAMQOR BLE] Ошибка переподключения (попытка ${this.reconnectAttempts}):`, err.message || err);
        this.attemptAutoReconnect();
      }
    }, delayMs);
  }

  async reconnectToExistingDevice() {

    if (!this.device || !this.device.gatt) {
      throw new Error('Устройство BLE недоступно для переподключения');
    }

    const {
      serviceUuid,
      characteristicUuid
    } = MODEL_CONFIG.ble;

    // Снимаем старый слушатель gattserverdisconnected
    this.device.removeEventListener(
      'gattserverdisconnected',
      this.handleDisconnectEvent
    );
    this.device.addEventListener(
      'gattserverdisconnected',
      this.handleDisconnectEvent
    );

    console.log(`[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Повторное gatt.connect() к ${this.deviceName}...`);
    this.server = await this.device.gatt.connect();

    const service =
      await this.server.getPrimaryService(serviceUuid);

    this.characteristic =
      await service.getCharacteristic(characteristicUuid);

    await this.characteristic.startNotifications();

    this.characteristic.removeEventListener(
      'characteristicvaluechanged',
      this.handleCharacteristicChange
    );
    this.characteristic.addEventListener(
      'characteristicvaluechanged',
      this.handleCharacteristicChange
    );

    if (typeof window !== 'undefined') {
      window.__qamqor_ble_device = this.device;
      window.__qamqor_ble_server = this.server;
      window.__qamqor_ble_char = this.characteristic;
    }

    this.isConnected = true;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.connectionStartTime = Date.now();
    this.lastPacketTime = Date.now();

    this.updateStatus(
      'connected_receiving',
      'Соединение восстановлено'
    );

    console.log(
      `[QAMQOR BLE] [${new Date().toLocaleTimeString('ru-RU')}] Соединение с ${this.deviceName} успешно восстановлено!`
    );
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
    );
  }

  // =========================================
  // PACKET HANDLER
  // =========================================

  handlePacket(event) {

    try {

      const dataView = event.target.value;
      const decoder = new TextDecoder('utf-8');
      const rawChunk = decoder.decode(dataView);

      if (!rawChunk) return;

      this.lastPacketTime = Date.now();
      this.packetCount++;

      // Очистка от \0 (null-байтов) и непечатных управляющих символов (кроме перевода строк)
      const cleanChunk = rawChunk.replace(/\0/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
      this.packetBuffer += cleanChunk;

      // Защита от переполнения буфера (храним хвост)
      if (this.packetBuffer.length > 2048) {
        this.packetBuffer = this.packetBuffer.slice(-512);
      }

      console.log(
        '[QAMQOR BLE] Received chunk:',
        cleanChunk
      );

      // Извлечение JSON-объектов из потокового буфера
      let parsedObjects = [];
      let lastEndIndex = 0;
      let braceDepth = 0;
      let startIndex = -1;

      for (let i = 0; i < this.packetBuffer.length; i++) {
        const ch = this.packetBuffer[i];
        if (ch === '{') {
          if (braceDepth === 0) startIndex = i;
          braceDepth++;
        } else if (ch === '}') {
          braceDepth--;
          if (braceDepth === 0 && startIndex !== -1) {
            const candidate = this.packetBuffer.substring(startIndex, i + 1);
            try {
              const obj = JSON.parse(candidate);
              parsedObjects.push({ obj, raw: candidate });
              lastEndIndex = i + 1;
            } catch (err) {
              // Попытка спарсить через Regex, если JSON поврежден внутри
              const hrM = candidate.match(/(?:heartRate|heart_rate|bpm|hr)\s*[:=]\s*(\d+)/i);
              const spM = candidate.match(/(?:spo2|o2|oximeter)\s*[:=]\s*(\d+)/i);
              if (hrM && spM) {
                parsedObjects.push({
                  obj: {
                    status: 'receiving',
                    heartRate: parseInt(hrM[1], 10),
                    spo2: parseInt(spM[1], 10)
                  },
                  raw: candidate
                });
                lastEndIndex = i + 1;
              }
            }
            startIndex = -1;
          }
        }
      }

      // Если полных фигурных скобок не найдено, но в буфере есть готовые числа ЧСС и SpO2
      if (parsedObjects.length === 0) {
        const hrM = this.packetBuffer.match(/(?:heartRate|heart_rate|bpm|hr)\s*[:=]\s*(\d+)/i);
        const spM = this.packetBuffer.match(/(?:spo2|o2|oximeter)\s*[:=]\s*(\d+)/i);
        if (hrM && spM) {
          parsedObjects.push({
            obj: {
              status: 'receiving',
              heartRate: parseInt(hrM[1], 10),
              spo2: parseInt(spM[1], 10)
            },
            raw: this.packetBuffer.trim()
          });
          this.packetBuffer = '';
        }
      } else {
        // Удаляем распознанные пакеты из буфера
        this.packetBuffer = this.packetBuffer.substring(lastEndIndex);
      }

      if (parsedObjects.length === 0) {
        // Ожидание завершения передачи MTU-фрагмента
        return;
      }

      // Берем самый последний актуальный пакет из очереди
      const latest = parsedObjects[parsedObjects.length - 1];
      const json = latest.obj;
      const rawText = latest.raw;

      console.log(
        '[QAMQOR BLE] Parsed JSON:',
        json
      );

      // =====================================
      // DEVICE STATUS
      // =====================================
      const rawStatus = String(json.status || 'receiving').toLowerCase();
      const isExplicitNoData = ['calculating', 'no_finger', 'sensor_error', 'initializing'].includes(rawStatus);

      // Чтение биометрии: поддержка heartRate, bpm, spo2
      const bpm = Number(json.heartRate ?? json.bpm);
      const spo2 = Number(json.spo2);
      const rawEcg = json.ecg != null ? Number(json.ecg) : null;
      const hasActiveECG = Number.isFinite(rawEcg) && rawEcg > 10 && rawEcg < 4085 && rawEcg !== 2048;

      if (isExplicitNoData || !Number.isFinite(bpm) || !Number.isFinite(spo2) || bpm <= 0 || spo2 <= 0) {
        const devStatus = json.status || 'connected_no_data';
        this.emitEmptyTelemetry(devStatus);
        this.updateStatus('connected_no_data', this.getStatusText(devStatus));
        return;
      }

      // =====================================
      // VALIDATE PULSE OXIMETRY
      // =====================================

      const pulseValidation =
        validatePulseOximetry(bpm, spo2);

      const isValid =
        pulseValidation?.isValid === true &&
        Number.isFinite(Number(pulseValidation.bpm)) &&
        Number.isFinite(Number(pulseValidation.spo2)) &&
        Number(pulseValidation.bpm) >= 40 &&
        Number(pulseValidation.bpm) <= 200 &&
        Number(pulseValidation.spo2) >= 70 &&
        Number(pulseValidation.spo2) <= 100;

      if (!isValid) {

        console.warn(
          '[QAMQOR BLE] Measurement rejected (outside limits):',
          bpm,
          spo2
        );

        this.emitEmptyTelemetry('invalid');
        this.updateStatus('connected_no_data', this.getStatusText('invalid'));
        return;
      }

      // =====================================
      // VALID TELEMETRY
      // =====================================

      const now = Date.now();

      let ecgQuality = null;
      let peakResult = null;
      if (hasActiveECG) {
        ecgQuality = checkECGSignalQuality(rawEcg, false);
        if (ecgQuality.isValid) {
          peakResult = this.rPeakDetector.processSample(rawEcg, now);
        }
      }

      const telemetry = {

        bpm: Number(pulseValidation.bpm),

        spo2: Number(pulseValidation.spo2),

        rawBpm: bpm,

        rawSpO2: spo2,

        ecg: hasActiveECG ? rawEcg : null,

        ecgQuality: ecgQuality,

        pulseValidation,

        hasValidSensors: true,

        hasActivePulse: true,

        hasActiveECG: hasActiveECG,

        rPeak: peakResult ? peakResult.peakDetected : false,

        instantaneousBpm: peakResult ? peakResult.instantaneousBpm : null,

        rrIntervals:
          this.rPeakDetector.getValidRRIntervals(),

        timestamp: now,

        status: 'receiving'
      };

      this.lastValidMeasurement = telemetry;

      this.isConnected = true;

      this.updateStatus(
        'connected_receiving',
        'Получение реальных данных'
      );

      if (this.onTelemetry) {
        try {
          this.onTelemetry(telemetry);
        } catch (consumerErr) {
          console.error('[QAMQOR BLE] Ошибка в обработчике onTelemetry приложения:', consumerErr);
        }
      }

      console.log(
        '[QAMQOR BLE] Valid telemetry:',
        {
          bpm: telemetry.bpm,
          spo2: telemetry.spo2
        }
      );

    } catch (error) {

      console.error(
        '[QAMQOR BLE] Packet processing error:',
        error
      );

      if (this.onError) {
        this.onError(error);
      }
    }
  }

  // =========================================
  // STATUS TEXT
  // =========================================

  getStatusText(status) {

    const messages = {

      receiving:
        'Получение реальных данных',

      calculating:
        'Рассчитываются показатели',

      no_finger:
        'Приложите палец к датчику',

      sensor_error:
        'Ошибка датчика MAX30102',

      initializing:
        'Инициализация браслета',

      invalid:
        'Некорректные измерения'
    };

    return (
      messages[status] ||
      'Ожидание данных'
    );
  }
}
