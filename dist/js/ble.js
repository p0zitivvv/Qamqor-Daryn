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
    this.lastPulseTime = null;
    this.lastEcgTime = null;
    this.lastValidMeasurement = null;
    this.lastValidPulse = null;
    this.lastValidECG = null;

    this.pulseSensorStatus = 'disconnected'; // 'ok' | 'no_finger' | 'calculating' | 'sensor_error' | 'disconnected' | 'invalid' | 'waiting'
    this.ecgSensorStatus = 'disconnected';   // 'ok' | 'leads_off' | 'clipped' | 'disconnected' | 'waiting'
    this.bleConnectionStatus = 'disconnected'; // 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

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

  emitEmptyTelemetry(status = 'disconnected') {

    this.rPeakDetector.reset();

    this.lastValidMeasurement = null;
    this.lastValidPulse = null;
    this.lastValidECG = null;

    if (status === 'disconnected') {
      this.pulseSensorStatus = 'disconnected';
      this.ecgSensorStatus = 'disconnected';
      this.bleConnectionStatus = 'disconnected';
    } else {
      if (status === 'no_finger') {
        this.pulseSensorStatus = 'no_finger';
      } else if (status === 'calculating') {
        this.pulseSensorStatus = 'calculating';
      } else if (status === 'sensor_error') {
        this.pulseSensorStatus = 'sensor_error';
      } else if (status === 'invalid') {
        this.pulseSensorStatus = 'invalid';
      } else {
        this.pulseSensorStatus = 'waiting';
      }
      this.ecgSensorStatus = 'waiting';
      this.bleConnectionStatus = 'connected';
    }

    if (this.onTelemetry) {

      this.onTelemetry({

        bpm: null,
        spo2: null,

        rawBpm: null,
        rawSpO2: null,

        ecg: null,
        ecgSamples: [],
        ecgQuality: null,

        pulseValidation: {
          isValid: false,
          bpm: null,
          spo2: null
        },

        hasValidSensors: false,
        hasActivePulse: false,
        hasActiveECG: false,

        pulseSensorStatus: this.pulseSensorStatus,
        ecgSensorStatus: this.ecgSensorStatus,
        bleConnectionStatus: this.bleConnectionStatus,

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

  // =========================================
  // PACKET HANDLER & INDEPENDENT SENSOR PARSING
  // =========================================

  handlePacket(event) {
    try {
      let rawChunk = '';
      if (typeof event === 'string') {
        rawChunk = event;
      } else if (event && event.target && event.target.value) {
        const dataView = event.target.value;
        const decoder = new TextDecoder('utf-8');
        rawChunk = decoder.decode(dataView);
      } else if (event instanceof DataView || (typeof ArrayBuffer !== 'undefined' && event instanceof ArrayBuffer)) {
        const dv = event instanceof DataView ? event : new DataView(event);
        const decoder = new TextDecoder('utf-8');
        rawChunk = decoder.decode(dv);
      } else if (event && typeof event === 'object' && !event.target) {
        // Direct object passed for testing or simulation
        return this.parsePacketObject(event);
      }

      if (!rawChunk) return;

      this.lastPacketTime = Date.now();
      this.packetCount++;

      // Очистка от \0 (null-байтов) и непечатных управляющих символов
      const cleanChunk = rawChunk.replace(/\0/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
      this.packetBuffer += cleanChunk;

      // Защита от переполнения буфера (сохраняем хвост)
      if (this.packetBuffer.length > 4096) {
        this.packetBuffer = this.packetBuffer.slice(-1024);
      }

      // Извлечение JSON-объектов из потокового буфера (с поддержкой строк и вложенности)
      let parsedObjects = [];
      let lastEndIndex = 0;

      for (let s = 0; s < this.packetBuffer.length; s++) {
        if (this.packetBuffer[s] !== '{') continue;

        let braceDepth = 0;
        let inString = false;
        let escape = false;

        for (let e = s; e < this.packetBuffer.length; e++) {
          const ch = this.packetBuffer[e];
          if (escape) {
            escape = false;
            continue;
          }
          if (ch === '\\') {
            escape = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (ch === '{') {
              braceDepth++;
            } else if (ch === '}') {
              braceDepth--;
              if (braceDepth === 0) {
                const candidate = this.packetBuffer.substring(s, e + 1);
                try {
                  const obj = JSON.parse(candidate);
                  parsedObjects.push({ obj, raw: candidate });
                  lastEndIndex = e + 1;
                  s = e; // переход к концу найденного объекта
                  break;
                } catch (err) {
                  // Попытка восстановить через Regex, если JSON поврежден внутри
                  const hrM = candidate.match(/(?:heartRate|heart_rate|bpm|hr)\s*[:=]\s*(\d+)/i);
                  const spM = candidate.match(/(?:spo2|o2|oximeter)\s*[:=]\s*(\d+)/i);
                  const ecgM = candidate.match(/(?:ecg|raw_ecg|adc)\s*[:=]\s*(\d+)/i);
                  const stM = candidate.match(/status\s*[:=]\s*["']?([a-zA-Z0-9_-]+)["']?/i);
                  if (hrM || spM || ecgM || stM) {
                    const recovered = {};
                    if (hrM) recovered.bpm = parseInt(hrM[1], 10);
                    if (spM) recovered.spo2 = parseInt(spM[1], 10);
                    if (ecgM) recovered.ecg = parseInt(ecgM[1], 10);
                    if (stM) recovered.status = stM[1];
                    parsedObjects.push({ obj: recovered, raw: candidate });
                    lastEndIndex = e + 1;
                    s = e;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      // Если полных фигурных скобок не найдено, но в буфере есть готовые числа
      if (parsedObjects.length === 0) {
        const hrM = this.packetBuffer.match(/(?:heartRate|heart_rate|bpm|hr)\s*[:=]\s*(\d+)/i);
        const spM = this.packetBuffer.match(/(?:spo2|o2|oximeter)\s*[:=]\s*(\d+)/i);
        const ecgM = this.packetBuffer.match(/(?:ecg|raw_ecg|adc)\s*[:=]\s*(\d+)/i);
        if ((hrM && spM) || ecgM) {
          const recObj = {};
          if (hrM) recObj.bpm = parseInt(hrM[1], 10);
          if (spM) recObj.spo2 = parseInt(spM[1], 10);
          if (ecgM) recObj.ecg = parseInt(ecgM[1], 10);
          recObj.status = 'receiving';
          parsedObjects.push({ obj: recObj, raw: this.packetBuffer.trim() });
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

      // ВАЖНО: обрабатываем КАЖДЫЙ распознанный пакет по очереди, не отбрасывая промежуточные отсчеты ЭКГ!
      for (const item of parsedObjects) {
        this.parsePacketObject(item.obj, item.raw);
      }

    } catch (error) {
      console.error('[QAMQOR BLE] Packet processing error:', error);
      if (this.onError) {
        this.onError(error);
      }
    }
  }

  /**
   * Независимая обработка биометрии MAX30102 и AD8232 из единого пакета JSON
   */
  parsePacketObject(json, rawText = '') {
    if (!json || typeof json !== 'object') return null;

    const now = Date.now();
    this.lastPacketTime = now;
    this.isConnected = true;
    this.bleConnectionStatus = 'connected';

    // --------------------------------------------------------------------
    // 1. MAX30102: ИЗВЛЕЧЕНИЕ ПУЛЬСА (BPM) И САТУРАЦИИ (SpO2)
    // --------------------------------------------------------------------
    let hasActivePulse = false;
    let validatedBpm = null;
    let validatedSpo2 = null;
    let pulseValidation = { isValid: false, bpm: null, spo2: null };
    let currentPulseStatus = 'waiting';

    const rawStatus = String(json.status || json.pulseStatus || '').toLowerCase();
    const rawBpm = json.heartRate != null ? Number(json.heartRate) : (json.bpm != null ? Number(json.bpm) : (json.hr != null ? Number(json.hr) : null));
    const rawSpo2 = json.spo2 != null ? Number(json.spo2) : (json.o2 != null ? Number(json.o2) : null);

    const isExplicitPulseNoData = ['no_finger', 'calculating', 'sensor_error', 'initializing'].includes(rawStatus);

    if (rawStatus === 'no_finger') {
      currentPulseStatus = 'no_finger';
      this.lastValidPulse = null;
    } else if (rawStatus === 'calculating') {
      currentPulseStatus = 'calculating';
    } else if (rawStatus === 'sensor_error') {
      currentPulseStatus = 'sensor_error';
      this.lastValidPulse = null;
    } else if (rawStatus === 'initializing') {
      currentPulseStatus = 'initializing';
    } else if (Number.isFinite(rawBpm) && Number.isFinite(rawSpo2)) {
      if (rawBpm <= 0 || rawSpo2 <= 0) {
        // Датчик физически не зафиксировал палец (прошивка шлет 0 при отсутствии контакта)
        currentPulseStatus = 'no_finger';
        this.lastValidPulse = null;
      } else {
        const valRes = validatePulseOximetry(rawBpm, rawSpo2);
        pulseValidation = valRes;
        if (valRes && valRes.isValid) {
          currentPulseStatus = 'ok';
          hasActivePulse = true;
          validatedBpm = valRes.bpm;
          validatedSpo2 = valRes.spo2;
          this.lastPulseTime = now;
          this.lastValidPulse = { bpm: validatedBpm, spo2: validatedSpo2, timestamp: now };
        } else {
          currentPulseStatus = 'invalid';
        }
      }
    } else {
      // В этом конкретном пакете данных MAX30102 нет (например, выделенный ЭКГ-пакет)
      if (this.lastPulseTime && (now - this.lastPulseTime < 3500) && this.lastValidPulse) {
        // Предыдущий замер пульса еще свежий (менее 3.5 сек)
        currentPulseStatus = 'ok';
        hasActivePulse = true;
        validatedBpm = this.lastValidPulse.bpm;
        validatedSpo2 = this.lastValidPulse.spo2;
        pulseValidation = { isValid: true, bpm: validatedBpm, spo2: validatedSpo2 };
      } else {
        currentPulseStatus = isExplicitPulseNoData ? rawStatus : (this.pulseSensorStatus === 'disconnected' ? 'disconnected' : 'waiting');
      }
    }

    this.pulseSensorStatus = currentPulseStatus;

    // --------------------------------------------------------------------
    // 2. AD8232: ИЗВЛЕЧЕНИЕ СИГНАЛА ЭКГ, КОНТРОЛЬ КАЧЕСТВА И R-ПИКИ
    // --------------------------------------------------------------------
    let hasActiveECG = false;
    let ecgSamples = [];
    let latestSample = null;
    let latestEcgQuality = null;
    let peakDetected = false;
    let instantaneousBpm = null;
    let currentEcgStatus = 'waiting';

    const isLeadsOff = Boolean(
      json.leadsOff === true ||
      json.lo === 1 ||
      json.lo === true ||
      json.lead_off === true ||
      json.leads_off === true
    );

    if (Array.isArray(json.samples)) {
      ecgSamples = json.samples.map(Number).filter(Number.isFinite);
    } else if (Array.isArray(json.ecgSamples)) {
      ecgSamples = json.ecgSamples.map(Number).filter(Number.isFinite);
    } else if (json.ecg != null && Number.isFinite(Number(json.ecg))) {
      ecgSamples = [Number(json.ecg)];
    }

    if (isLeadsOff) {
      currentEcgStatus = 'leads_off';
      latestEcgQuality = { isValid: false, isLeadsOff: true, isClipped: false, message: 'Обрыв электродов (Leads Off)' };
      this.lastValidECG = null;
    } else if (ecgSamples.length > 0) {
      let anyValid = false;
      for (const sample of ecgSamples) {
        latestSample = sample;
        const q = checkECGSignalQuality(sample, false);
        latestEcgQuality = q;

        // Если датчик AD8232 висит на ровной изолинии 2048 (не подключен)
        if (sample === 2048 && ecgSamples.length === 1 && !json.samples) {
          // Изолиния без динамики
          currentEcgStatus = 'leads_off';
        } else if (!q.isValid && q.isClipped) {
          currentEcgStatus = 'clipped';
        } else if (q.isValid) {
          anyValid = true;
          currentEcgStatus = 'ok';
          const peakRes = this.rPeakDetector.processSample(sample, now);
          if (peakRes && peakRes.peakDetected) {
            peakDetected = true;
            if (peakRes.instantaneousBpm) {
              instantaneousBpm = peakRes.instantaneousBpm;
            }
          }
        }
      }

      if (anyValid) {
        hasActiveECG = true;
        this.lastEcgTime = now;
        this.lastValidECG = { lastSample: latestSample, timestamp: now };
      }
    } else {
      // В этом пакете нет поля ЭКГ
      if (this.lastEcgTime && (now - this.lastEcgTime < 3000) && this.lastValidECG) {
        currentEcgStatus = 'ok';
        hasActiveECG = true;
        latestSample = this.lastValidECG.lastSample;
      } else {
        currentEcgStatus = this.ecgSensorStatus === 'disconnected' ? 'disconnected' : 'waiting';
      }
    }

    this.ecgSensorStatus = currentEcgStatus;

    // --------------------------------------------------------------------
    // 3. ФОРМИРОВАНИЕ ИТОГОВОЙ ДЕКУПЛИРОВАННОЙ ТЕЛЕМЕТРИИ
    // --------------------------------------------------------------------
    const rrIntervals = this.rPeakDetector.getValidRRIntervals();

    let overallStatus = 'connected_no_data';
    if (hasActivePulse && hasActiveECG) {
      overallStatus = 'receiving';
    } else if (hasActivePulse) {
      overallStatus = 'receiving_pulse_only';
    } else if (hasActiveECG) {
      overallStatus = 'receiving_ecg_only';
    } else if (currentPulseStatus === 'no_finger') {
      overallStatus = 'no_finger';
    } else if (currentPulseStatus === 'calculating') {
      overallStatus = 'calculating';
    } else if (currentPulseStatus === 'sensor_error') {
      overallStatus = 'sensor_error';
    }

    const telemetry = {
      // MAX30102
      bpm: hasActivePulse ? validatedBpm : null,
      spo2: hasActivePulse ? validatedSpo2 : null,
      rawBpm: Number.isFinite(rawBpm) ? rawBpm : null,
      rawSpO2: Number.isFinite(rawSpo2) ? rawSpo2 : null,
      pulseValidation,
      hasActivePulse,
      pulseSensorStatus: this.pulseSensorStatus,

      // AD8232
      ecg: hasActiveECG ? latestSample : null,
      ecgSamples: hasActiveECG ? ecgSamples : [],
      ecgQuality: latestEcgQuality,
      hasActiveECG,
      ecgSensorStatus: this.ecgSensorStatus,

      // R-Peak & RR-интервалы (строго из сигнала ЭКГ)
      rPeak: peakDetected,
      instantaneousBpm,
      rrIntervals,

      // Общие агрегированные флаги
      hasValidSensors: hasActivePulse || hasActiveECG,
      bleConnectionStatus: this.bleConnectionStatus,
      timestamp: now,
      status: overallStatus,
      rawJSON: json
    };

    if (hasActivePulse || hasActiveECG) {
      this.lastValidMeasurement = telemetry;
    }

    this.updateStatus(overallStatus, this.getStatusText(overallStatus));

    if (this.onTelemetry) {
      try {
        this.onTelemetry(telemetry);
      } catch (consumerErr) {
        console.error('[QAMQOR BLE] Consumer onTelemetry error:', consumerErr);
      }
    }

    return telemetry;
  }

  // =========================================
  // STATUS TEXT
  // =========================================

  getStatusText(status) {
    const messages = {
      receiving: 'Получение данных MAX30102 + AD8232',
      receiving_pulse_only: 'MAX30102 активен • Ожидание ЭКГ',
      receiving_ecg_only: 'AD8232 активен • Приложите палец к MAX30102',
      calculating: 'Рассчитываются показатели',
      no_finger: 'Приложите палец к датчику MAX30102',
      sensor_error: 'Ошибка датчика MAX30102',
      initializing: 'Инициализация браслета',
      invalid: 'Некорректные измерения',
      connected_no_data: 'Подключено. Ожидание данных датчиков',
      reconnecting: 'Соединение потеряно, переподключаюсь...',
      disconnected: 'Браслет отключён'
    };

    return messages[status] || 'Ожидание данных';
  }
}
