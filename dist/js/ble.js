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

    this.deviceName = 'Qamqor_Band';

    this.rPeakDetector = new RPeakDetector(25);

    this.onTelemetry = null;
    this.onStatusChange = null;
    this.onError = null;
    this.onDiagnostic = null;

    this.lastPacketTime = null;
    this.lastValidMeasurement = null;
    this.lastDiagnostic = null;

    this.packetCount = 0;
    this.packetBuffer = '';

    this.connectionTimeout = null;

    this.status = 'disconnected';

    this.handleCharacteristicChange =
      this.handlePacket.bind(this);

    this.handleDisconnectEvent =
      this.handleDisconnected.bind(this);
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
      window.isSecureContext ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
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

    if (!this.isSupported()) {

      throw new Error(
        'Браузер не поддерживает Web Bluetooth API.'
      );
    }

    if (!this.isSecureContext()) {

      throw new Error(
        'Web Bluetooth требует HTTPS или localhost.'
      );
    }

    try {

      const {
        serviceUuid,
        characteristicUuid
      } = MODEL_CONFIG.ble;

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

      this.deviceName =
        device.name || 'Qamqor_Band';

      this.device.addEventListener(
        'gattserverdisconnected',
        this.handleDisconnectEvent
      );

      console.log('[QAMQOR BLE] Connecting...');

      this.server = await device.gatt.connect();

      const service =
        await this.server.getPrimaryService(serviceUuid);

      this.characteristic =
        await service.getCharacteristic(characteristicUuid);

      await this.characteristic.startNotifications();

      this.characteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleCharacteristicChange
      );

      this.isConnected = true;

      this.lastPacketTime = Date.now();

      this.emitEmptyTelemetry('connected_no_data');

      this.updateStatus(
        'connected_no_data',
        'Подключено. Ожидание данных датчика'
      );

      console.log(
        '[QAMQOR BLE] Connected:',
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
  // DISCONNECT
  // =========================================

  disconnect() {

    if (this.device && this.device.gatt.connected) {

      this.device.gatt.disconnect();

    } else {

      this.handleDisconnected();
    }
  }

  handleDisconnected() {

    this.isConnected = false;

    this.characteristic = null;
    this.server = null;

    this.lastPacketTime = null;
    this.packetBuffer = '';
    this.packetCount = 0;

    this.emitEmptyTelemetry('disconnected');

    this.updateStatus(
      'disconnected',
      'Связь с браслетом потеряна'
    );

    if (this.onDiagnostic) {
      this.onDiagnostic({
        timestamp: new Date().toLocaleTimeString(),
        rawPacket: '—',
        parsedJson: null,
        validation: { isValid: false, reason: 'Соединение BLE разорвано' },
        uiData: { bpm: null, spo2: null, status: 'disconnected' },
        packetCount: 0
      });
    }

    console.warn(
      '[QAMQOR BLE] Disconnected'
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
        if (this.onDiagnostic) {
          this.onDiagnostic({
            timestamp: new Date().toLocaleTimeString(),
            rawPacket: cleanChunk,
            parsedJson: null,
            validation: { isValid: false, reason: 'Буферизация фрагмента BLE (ожидание закрытия JSON)...' },
            uiData: { bpm: null, spo2: null, status: 'buffering' },
            packetCount: this.packetCount
          });
        }
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

        if (this.onDiagnostic) {
          this.onDiagnostic({
            timestamp: new Date().toLocaleTimeString(),
            rawPacket: rawText,
            parsedJson: json,
            validation: { isValid: false, bpm, spo2, reason: `Статус: ${devStatus} (палец не приложен или расчет)` },
            uiData: { bpm: null, spo2: null, status: 'connected_no_data' },
            packetCount: this.packetCount
          });
        }
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

        if (this.onDiagnostic) {
          this.onDiagnostic({
            timestamp: new Date().toLocaleTimeString(),
            rawPacket: rawText,
            parsedJson: json,
            validation: { isValid: false, bpm, spo2, reason: `Отклонено: пульс ${bpm} или SpO2 ${spo2}% вне диапазона [40-200 / 70-100]` },
            uiData: { bpm: null, spo2: null, status: 'connected_no_data' },
            packetCount: this.packetCount
          });
        }

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

        this.onTelemetry(telemetry);
      }

      if (this.onDiagnostic) {
        this.onDiagnostic({
          timestamp: new Date().toLocaleTimeString(),
          rawPacket: rawText,
          parsedJson: json,
          validation: { isValid: true, bpm: telemetry.bpm, spo2: telemetry.spo2, reason: '✅ Физиологическая норма подтверждена' },
          uiData: { bpm: telemetry.bpm, spo2: telemetry.spo2, status: 'connected_receiving' },
          packetCount: this.packetCount
        });
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
