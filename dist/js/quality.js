/**
 * Qamqor Health Monitoring System
 * Модуль контроля качества и полноты данных (Data Quality Service)
 * Реализация требований раздела 8.1 и 16.4
 */

import { MODEL_CONFIG } from './config.js';
import { clip } from './model.js';

/**
 * Оценка качества измерений компонентов (q_j in [0, 1])
 * @param {Object} metrics 
 * @param {Object} baseline 
 * @returns {Object} { q_hr, q_hrv, q_spo2, q_arr, c_q, componentStatuses }
 */
export function calculateDataQuality(metrics, baseline) {
  const statuses = {
    hr: { valid: false, q: 0, reason: 'Нет данных' },
    hrv: { valid: false, q: 0, reason: 'Нет данных' },
    spo2: { valid: false, q: 0, reason: 'Нет данных' },
    arr: { valid: false, q: 0, reason: 'Нет данных' }
  };

  // 1. Пульс (HR)
  if (metrics && typeof metrics.hr === 'number' && !isNaN(metrics.hr)) {
    if (metrics.hr >= MODEL_CONFIG.signals.hr_min && metrics.hr <= MODEL_CONFIG.signals.hr_max) {
      statuses.hr = { valid: true, q: 1.0, value: metrics.hr };
    } else {
      statuses.hr = { valid: false, q: 0.0, reason: `Пульс вне физиологического диапазона [30, 220]: ${metrics.hr}` };
    }
  }

  // 2. HRV (SDNN)
  if (metrics && typeof metrics.sdnn === 'number' && !isNaN(metrics.sdnn)) {
    if (metrics.sdnn > 0) {
      // Проверяем, есть ли валидная базовая линия с ненулевой sigma
      if (baseline && baseline.isReady && baseline.sigmaHrv > MODEL_CONFIG.baseline.min_sigma_hrv) {
        statuses.hrv = { valid: true, q: 1.0, value: metrics.sdnn };
      } else {
        statuses.hrv = { valid: false, q: 0.3, reason: 'Базовая линия HRV не сформирована (требуется 7 дней)' };
      }
    } else {
      statuses.hrv = { valid: false, q: 0.0, reason: 'SDNN должен быть положительным числом' };
    }
  }

  // 3. SpO2
  if (metrics && typeof metrics.spo2 === 'number' && !isNaN(metrics.spo2)) {
    if (metrics.spo2 >= MODEL_CONFIG.signals.spo2_min && metrics.spo2 <= MODEL_CONFIG.signals.spo2_max) {
      statuses.spo2 = { valid: true, q: 1.0, value: metrics.spo2 };
    } else {
      statuses.spo2 = { valid: false, q: 0.0, reason: `SpO2 вне диапазона [70, 100]: ${metrics.spo2}%` };
    }
  }

  // 4. Нерегулярность ритма (p_irr / ARR)
  if (metrics && typeof metrics.pIrr === 'number' && !isNaN(metrics.pIrr)) {
    if (metrics.pIrr >= 0 && metrics.pIrr <= 1.0) {
      statuses.arr = { valid: true, q: 1.0, value: metrics.pIrr };
    } else {
      statuses.arr = { valid: false, q: 0.0, reason: 'p_irr должен быть в диапазоне [0, 1]' };
    }
  }

  // c_q = mean(q_j) по 4 компонентам
  const sumQ = statuses.hr.q + statuses.hrv.q + statuses.spo2.q + statuses.arr.q;
  const c_q = sumQ / 4.0;

  return {
    c_q,
    statuses
  };
}

/**
 * Расчет полноты персональной базовой линии (c_base)
 * c_base = min(1, days / 7)
 * @param {number} daysCollected - Количество дней сбора данных
 * @returns {number} Значение в [0, 1]
 */
export function calculateBaselineCompleteness(daysCollected) {
  if (typeof daysCollected !== 'number' || isNaN(daysCollected) || daysCollected <= 0) {
    return 0.0;
  }
  const daysTarget = MODEL_CONFIG.baseline.collection_days_target; // 7
  return clip(daysCollected / daysTarget, 0, 1.0);
}

/**
 * Итоговый коэффициент полноты и качества данных c = c_q * c_base
 * @param {number} c_q - Качество текущих измерений [0, 1]
 * @param {number} c_base - Полнота базовой линии [0, 1]
 * @returns {Object} { c, isSufficient, percentage, label }
 */
export function calculateOverallCompleteness(c_q, c_base) {
  const qVal = clip(typeof c_q === 'number' ? c_q : 0, 0, 1);
  const baseVal = clip(typeof c_base === 'number' ? c_base : 0, 0, 1);
  
  const c = Math.round(qVal * baseVal * 10000) / 10000;
  const isSufficient = c >= MODEL_CONFIG.quality.min_acceptable_c; // 0.5
  const percentage = Math.round(c * 100);

  let label = 'Высокая полнота данных';
  if (c < 0.3) {
    label = 'Критически мало данных';
  } else if (c < 0.5) {
    label = 'Недостаточно данных для расчета';
  } else if (c < 0.75) {
    label = 'Умеренная полнота данных';
  }

  return {
    c,
    c_q: qVal,
    c_base: baseVal,
    isSufficient,
    percentage,
    label
  };
}
