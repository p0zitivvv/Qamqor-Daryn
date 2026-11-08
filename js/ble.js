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

    this.lastPacketTime = null;
    this.lastValidMeasurement = null;

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

    this.emitEmptyTelemetry('disconnected');

    this.updateStatus(
      'disconnected',
      'Связь с браслетом потеряна'
    );

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

      const text = decoder.decode(dataView).trim();

      if (!text) return;

      this.lastPacketTime = Date.now();

      console.log(
        '[QAMQOR BLE] Received:',
        text
      );

      let json;

      try {

        json = JSON.parse(text);

      } catch (error) {

        console.warn(
          '[QAMQOR BLE] Invalid JSON:',
          text
        );

        return;
      }

      // =====================================
      // DEVICE STATUS
      // =====================================

      const deviceStatus = json.status || 'receiving';

      if (deviceStatus !== 'receiving') {

        const statusMap = {

          calculating: 'connected_no_data',

          no_finger: 'connected_no_data',

          sensor_error: 'connected_no_data',

          initializing: 'connected_no_data'
        };

        const uiStatus =
          statusMap[deviceStatus] ||
          'connected_no_data';

        this.emitEmptyTelemetry(deviceStatus);

        this.updateStatus(
          uiStatus,
          this.getStatusText(deviceStatus)
        );

        return;
      }

      // =====================================
      // PARSE REAL MEASUREMENTS
      // =====================================

      const bpm = Number(
        json.heartRate ?? json.bpm
      );

      const spo2 = Number(json.spo2);

      const rawEcg = json.ecg != null ? Number(json.ecg) : null;
      const hasActiveECG = Number.isFinite(rawEcg) && rawEcg > 10 && rawEcg < 4085 && rawEcg !== 2048;

      if (
        !Number.isFinite(bpm) ||
        !Number.isFinite(spo2)
      ) {

        console.warn(
          '[QAMQOR BLE] Invalid measurement values'
        );

        this.emitEmptyTelemetry('invalid');

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
          '[QAMQOR BLE] Measurement rejected (no finger or invalid):',
          bpm,
          spo2
        );

        this.emitEmptyTelemetry('invalid');

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
