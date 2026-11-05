/**
 * Qamqor Health Monitoring System
 * Модуль машины состояний уведомлений и тревог (Alert Engine with Hysteresis)
 * Реализация спецификации раздела 9 и 16.6
 */

import { MODEL_CONFIG } from './config.js';

export const AlertState = {
  ARMED: 'ARMED',                         // Взведено: предыдущий индекс был < 30, готов к отслеживанию
  MONITORING: 'MONITORING',               // Индекс от 30 до 39, тревога не взведена повторно
  PENDING: 'PENDING',                     // I >= 40, идет накопление времени (1..4 мин)
  TRIGGERED: 'TRIGGERED',                 // 5 минут подряд при c >= 0.5 — Тревога активна!
  SUPPRESSED_POOR_QUALITY: 'SUPPRESSED'  // I >= 40, но c < 0.5 — тревога заблокирована
};

export class AlertEngine {
  constructor(initialState = null) {
    this.threshold = MODEL_CONFIG.alerts.threshold_index;           // 40
    this.persistenceTarget = MODEL_CONFIG.alerts.persistence_minutes; // 5 минут
    this.minQuality = MODEL_CONFIG.alerts.min_quality;               // 0.5
    this.recoveryThreshold = MODEL_CONFIG.alerts.hysteresis_recovery_index; // 30

    // Текущее состояние
    this.state = AlertState.ARMED;
    this.consecutiveMinutes = 0;
    this.wasBelowRecovery = true; // Было ли значение ниже 30 для взвода гистерезиса
    this.lastTriggerTime = null;
    this.lastAlertMessage = null;
    this.history = [];

    if (initialState) {
      this.load(initialState);
    }
  }

  /**
   * Обновление состояния автомата на каждом минутном шаге
   * 
   * @param {Object} stepData
   * @param {number} stepData.index - Текущий сглаженный индекс I (0 - 100)
   * @param {number} stepData.c - Коэффициент качества данных [0, 1]
   * @param {number} [stepData.timestamp] - Временная метка
   * 
   * @returns {Object} { state, shouldAlert, alertMessage, consecutiveMinutes, wasBelowRecovery }
   */
  update({ index, c, timestamp = Date.now() }) {
    if (typeof index !== 'number' || isNaN(index)) {
      return {
        state: this.state,
        shouldAlert: false,
        consecutiveMinutes: this.consecutiveMinutes,
        reason: 'Некорректный индекс'
      };
    }

    const quality = typeof c === 'number' && !isNaN(c) ? c : 0;
    let shouldAlert = false;
    let alertMessage = null;

    // 1. Проверка гистерезиса восстановления: если I < 30, взводим готовность
    if (index < this.recoveryThreshold) {
      this.wasBelowRecovery = true;
      if (this.state === AlertState.TRIGGERED || this.state === AlertState.MONITORING) {
        this.state = AlertState.ARMED;
      }
    }

    // 2. Проверка преодоления порога I >= 40
    if (index >= this.threshold) {
      // Проверка качества данных c >= 0.5
      if (quality < this.minQuality) {
        // Качество недостаточно — блокируем тревогу
        this.consecutiveMinutes = 0;
        this.state = AlertState.SUPPRESSED_POOR_QUALITY;
        return {
          state: this.state,
          shouldAlert: false,
          consecutiveMinutes: 0,
          reason: `Тревога заблокирована: качество данных (${Math.round(quality * 100)}%) ниже минимального (50%)`
        };
      }

      // Качество высокое (c >= 0.5)
      // Если индекс не восстанавливался ниже 30, тревога не взводится (гистерезис)
      if (!this.wasBelowRecovery) {
        this.consecutiveMinutes = 0;
        this.state = AlertState.MONITORING;
        return {
          state: this.state,
          shouldAlert: false,
          consecutiveMinutes: 0,
          reason: 'Ожидается снижение индекса ниже 30 для взвода гистерезиса'
        };
      }

      // Наращиваем счетчик минут превышения
      this.consecutiveMinutes++;

      if (this.consecutiveMinutes >= this.persistenceTarget) {
        if (this.state !== AlertState.TRIGGERED) {
          // ПЕРВОЕ СРАБАТЫВАНИЕ ТРЕВОГИ ПОСЛЕ 5 МИНУТ
          this.state = AlertState.TRIGGERED;
          this.wasBelowRecovery = false; // Сбрасываем флаг взвода гистерезиса
          this.lastTriggerTime = timestamp;
          shouldAlert = true;

          // Нейтральное ответственное сообщение (раздел 9)
          alertMessage = 'Индекс Qamqor находится в красной зоне по экспериментальной модели. Проверьте качество измерений и своё самочувствие. Этот показатель не является диагнозом.';
          this.lastAlertMessage = alertMessage;

          this.history.unshift({
            timestamp,
            index,
            c: quality,
            message: alertMessage
          });
        }
      } else {
        this.state = AlertState.PENDING;
      }
    } else {
      // Индекс < 40
      this.consecutiveMinutes = 0;
      if (this.state !== AlertState.TRIGGERED) {
        if (index < this.recoveryThreshold) {
          this.state = AlertState.ARMED;
        } else {
          this.state = AlertState.MONITORING;
        }
      } else {
        // Если уже был TRIGGERED, остаемся в TRIGGERED пока индекс не опустится ниже 30
        if (index < this.recoveryThreshold) {
          this.state = AlertState.ARMED;
        }
      }
    }

    return {
      state: this.state,
      shouldAlert,
      alertMessage,
      consecutiveMinutes: this.consecutiveMinutes,
      wasBelowRecovery: this.wasBelowRecovery
    };
  }

  reset() {
    this.state = AlertState.ARMED;
    this.consecutiveMinutes = 0;
    this.wasBelowRecovery = true;
    this.lastTriggerTime = null;
    this.lastAlertMessage = null;
  }

  toJSON() {
    return {
      state: this.state,
      consecutiveMinutes: this.consecutiveMinutes,
      wasBelowRecovery: this.wasBelowRecovery,
      lastTriggerTime: this.lastTriggerTime,
      lastAlertMessage: this.lastAlertMessage,
      history: this.history.slice(0, 50)
    };
  }

  load(data) {
    if (!data) return;
    this.state = data.state || AlertState.ARMED;
    this.consecutiveMinutes = data.consecutiveMinutes || 0;
    this.wasBelowRecovery = data.wasBelowRecovery !== undefined ? data.wasBelowRecovery : true;
    this.lastTriggerTime = data.lastTriggerTime || null;
    this.lastAlertMessage = data.lastAlertMessage || null;
    this.history = Array.isArray(data.history) ? data.history : [];
  }
}
