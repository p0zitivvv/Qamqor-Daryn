/**
 * Qamqor Health Monitoring System
 * Модуль сбора и цифровой обработки биосигналов (Signal Processing Engine)
 * Реализация спецификации раздела 7 и 16.7
 */

import { MODEL_CONFIG } from './config.js';

/**
 * Валидация измерения пульсоксиметра MAX30102
 * @param {number} bpm - ЧСС (уд/мин)
 * @param {number} spo2 - Сатурация (%)
 * @returns {Object} { isValid, bpm, spo2, reason }
 */
export function validatePulseOximetry(bpm, spo2) {
  if (typeof bpm !== 'number' || isNaN(bpm) || typeof spo2 !== 'number' || isNaN(spo2)) {
    return { isValid: false, reason: 'Показатели должны быть числами' };
  }

  // Контакт с пальцем отсутствует (в ESP32 отправляется 0)
  if (bpm <= 0 || spo2 <= 0) {
    return { isValid: false, reason: 'Потеря контакта с датчиком MAX30102 (палец снят)' };
  }

  if (bpm < MODEL_CONFIG.signals.hr_min || bpm > MODEL_CONFIG.signals.hr_max) {
    return { isValid: false, bpm, spo2, reason: `Пульс вне физиологического диапазона [30, 220]: ${bpm}` };
  }

  if (spo2 < MODEL_CONFIG.signals.spo2_min || spo2 > MODEL_CONFIG.signals.spo2_max) {
    return { isValid: false, bpm, spo2, reason: `SpO2 вне диапазона [70, 100]: ${spo2}%` };
  }

  return { isValid: true, bpm: Math.round(bpm), spo2: Math.round(spo2) };
}

/**
 * Проверка валидности RR-интервала (раздел 7.2)
 * 0.27 <= RR <= 2.0 секунд
 * @param {number} rrSec - Длительность RR-интервала в секундах
 * @returns {boolean}
 */
export function isValidRRInterval(rrSec) {
  if (typeof rrSec !== 'number' || isNaN(rrSec)) return false;
  return rrSec >= MODEL_CONFIG.signals.rr_min_sec && rrSec <= MODEL_CONFIG.signals.rr_max_sec;
}

/**
 * Расчет SDNN по валидным RR-интервалам (в миллисекундах)
 * SDNN = sqrt( (1 / (N - 1)) * sum( (RR_i - mean(RR))^2 ) )
 * 
 * @param {number[]} rrIntervalsSec - Массив RR-интервалов в секундах
 * @returns {number|null} SDNN в миллисекундах или null при недостатке данных
 */
export function calculateSDNN(rrIntervalsSec) {
  if (!Array.isArray(rrIntervalsSec)) return null;

  // Фильтрация только валидных интервалов [0.27, 2.0]
  const validRR = rrIntervalsSec.filter(isValidRRInterval);
  if (validRR.length < 5) {
    return null; // Недостаточно данных для статистической оценки вариабельности
  }

  // Переводим в миллисекунды для стандартной шкалы SDNN
  const rrMs = validRR.map(r => r * 1000);
  const n = rrMs.length;
  const mean = rrMs.reduce((acc, v) => acc + v, 0) / n;

  const sumSquares = rrMs.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0);
  const variance = sumSquares / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Расчет RMSSD для исследовательской диагностики (раздел 7.2)
 * RMSSD = sqrt( (1 / (N - 1)) * sum( (RR_{i+1} - RR_i)^2 ) )
 * @param {number[]} rrIntervalsSec 
 * @returns {number|null} RMSSD в мс
 */
export function calculateRMSSD(rrIntervalsSec) {
  if (!Array.isArray(rrIntervalsSec)) return null;
  const validRR = rrIntervalsSec.filter(isValidRRInterval);
  if (validRR.length < 5) return null;

  const rrMs = validRR.map(r => r * 1000);
  let sumDiffSquares = 0;
  for (let i = 0; i < rrMs.length - 1; i++) {
    const diff = rrMs[i + 1] - rrMs[i];
    sumDiffSquares += diff * diff;
  }
  return Math.sqrt(sumDiffSquares / (rrMs.length - 1));
}

/**
 * Расчет показателя нерегулярности ритма p_irr (раздел 2, 5.4)
 * p_irr = (1 / (N - 1)) * count( |RR_i - RR_{i-1}| > 0.20 * RR_{i-1} )
 * 
 * @param {number[]} rrIntervalsSec 
 * @returns {number|null} Доля нерегулярных переходов в [0, 1]
 */
export function calculateRhythmIrregularity(rrIntervalsSec) {
  if (!Array.isArray(rrIntervalsSec)) return null;
  const validRR = rrIntervalsSec.filter(isValidRRInterval);
  if (validRR.length < 5) return null;

  const threshold = MODEL_CONFIG.dynamic.arr_relative_threshold; // 0.20 (20%)
  let irregularCount = 0;

  for (let i = 1; i < validRR.length; i++) {
    const prev = validRR[i - 1];
    const curr = validRR[i];
    const diff = Math.abs(curr - prev);
    if (diff > threshold * prev) {
      irregularCount++;
    }
  }

  return irregularCount / (validRR.length - 1);
}

/**
 * Проверка качества аналогового сигнала ЭКГ с AD8232
 * @param {number} adcValue - 12-битное значение ADC (0 - 4095)
 * @param {boolean} [leadsOff] - Аппаратный флаг LO+ / LO-
 * @returns {Object} { isValid, isLeadsOff, isClipped, message }
 */
export function checkECGSignalQuality(adcValue, leadsOff = false) {
  if (leadsOff) {
    return { isValid: false, isLeadsOff: true, isClipped: false, message: 'Обрыв электродов (Leads Off)' };
  }
  // Насыщение / клиппинг (rail-to-rail)
  if (adcValue <= 5 || adcValue >= 4090) {
    return { isValid: false, isLeadsOff: false, isClipped: true, message: 'Клиппинг сигнала ЭКГ (насыщение ADC)' };
  }
  // Зависание на ровной изолинии 2048
  return { isValid: true, isLeadsOff: false, isClipped: false };
}

/**
 * Детектор R-пиков ЭКГ в реальном времени (адаптивный порог с рефрактерным периодом)
 */
export class RPeakDetector {
  constructor(sampleRateHz = 25) {
    this.sampleRateHz = sampleRateHz;
    this.refractorySamples = Math.floor(sampleRateHz * 0.25); // 250 мс рефрактерный период
    this.samplesSinceLastPeak = this.refractorySamples;

    // Адаптивный порог
    this.threshold = 2400; // Для 12-битного ADC (центр 2048)
    this.maxRecent = 2048;
    this.lastPeakTimeMs = null;
    this.rrIntervalsSec = [];
  }

  /**
   * Подать один отсчет ЭКГ
   * @param {number} sample - Отсчет ADC (0 - 4095)
   * @param {number} timestampMs - Время отсчета
   * @returns {Object|null} Данные пика { peakDetected: true, rrSec, instantaneousBpm } или null
   */
  processSample(sample, timestampMs = Date.now()) {
    this.samplesSinceLastPeak++;

    // Обновляем плавающий максимум
    if (sample > this.maxRecent) {
      this.maxRecent = sample;
    } else {
      // Медленное затухание пикового детектора
      this.maxRecent *= 0.998;
    }

    // Динамический адаптивный порог: 2048 + 0.5 * (max - 2048)
    const dynamicThreshold = Math.max(2250, 2048 + 0.45 * (this.maxRecent - 2048));

    // Проверка R-пика: превышение порога + окончание рефрактерного периода
    if (sample > dynamicThreshold && this.samplesSinceLastPeak >= this.refractorySamples) {
      let rrSec = null;
      let instantaneousBpm = null;

      if (this.lastPeakTimeMs !== null) {
        rrSec = (timestampMs - this.lastPeakTimeMs) / 1000.0;
        if (isValidRRInterval(rrSec)) {
          this.rrIntervalsSec.push(rrSec);
          // Храним последние 300 интервалов (окно 5 минут при 60 уд/мин)
          if (this.rrIntervalsSec.length > 300) {
            this.rrIntervalsSec.shift();
          }
          instantaneousBpm = Math.round(60 / rrSec);
        }
      }

      this.lastPeakTimeMs = timestampMs;
      this.samplesSinceLastPeak = 0;

      return {
        peakDetected: true,
        rrSec,
        instantaneousBpm,
        timestampMs
      };
    }

    return null;
  }

  getValidRRIntervals() {
    return this.rrIntervalsSec.filter(isValidRRInterval);
  }

  reset() {
    this.samplesSinceLastPeak = this.refractorySamples;
    this.lastPeakTimeMs = null;
    this.rrIntervalsSec = [];
    this.maxRecent = 2048;
  }
}
