/**
 * Qamqor Health Monitoring System
 * Модуль персональной базовой линии (Personal Baseline Service)
 * Реализация спецификации раздела 6
 */

import { MODEL_CONFIG } from './config.js';

export const BaselineStatus = {
  NOT_STARTED: 'NOT_STARTED',
  COLLECTING: 'COLLECTING',       // Сбор данных
  INSUFFICIENT: 'INSUFFICIENT',   // Недостаточно данных
  READY: 'READY'                  // Базовая линия построена
};

/**
 * Расчет медианы массива чисел
 * @param {number[]} arr 
 * @returns {number}
 */
export function calculateMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Расчет среднего значения массива чисел
 * @param {number[]} arr 
 * @returns {number}
 */
export function calculateMean(arr) {
  if (!arr || arr.length === 0) return 0;
  const sum = arr.reduce((acc, v) => acc + v, 0);
  return sum / arr.length;
}

/**
 * Расчет несмещенного стандартного отклонения (sample standard deviation)
 * @param {number[]} arr 
 * @param {number} [mean] 
 * @returns {number}
 */
export function calculateStd(arr, mean = null) {
  if (!arr || arr.length < 2) return 0;
  const m = mean !== null ? mean : calculateMean(arr);
  const variance = arr.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Класс управления персональной базовой линией
 */
export class PersonalBaselineService {
  constructor(initialData = null) {
    this.version = MODEL_CONFIG.version;
    this.status = BaselineStatus.NOT_STARTED;
    
    // Параметры базовой линии
    this.hr0 = 70;              // Медианный пульс покоя
    this.lnSdnn0 = 3.8;          // Средний логарифм SDNN (ln(45) ≈ 3.806)
    this.sigmaHrv = 0.35;        // Стандартное отклонение ln(SDNN)
    
    // Метаданные сбора
    this.startDate = null;       // ISO дата начала
    this.lastUpdate = null;
    this.daysElapsed = 0;
    this.validWindowsCount = 0;
    
    // Буферы для накопления окон покоя: { timestamp, hr, sdnn }
    this.restingWindows = [];

    if (initialData) {
      this.load(initialData);
    }
  }

  /**
   * Добавить валидное 5-минутное окно покоя
   * @param {Object} windowData
   * @param {number} windowData.hr - Пульс в окне (уд/мин)
   * @param {number} windowData.sdnn - SDNN в окне (мс или сек)
   * @param {number} [windowData.timestamp] - Временная метка
   */
  addRestingWindow({ hr, sdnn, timestamp = Date.now() }) {
    // 1. Проверка физиологической валидности
    if (typeof hr !== 'number' || isNaN(hr) || hr < MODEL_CONFIG.signals.hr_min || hr > MODEL_CONFIG.signals.hr_max) {
      return false;
    }
    if (typeof sdnn !== 'number' || isNaN(sdnn) || sdnn <= 0) {
      return false;
    }

    if (!this.startDate) {
      this.startDate = timestamp;
      this.status = BaselineStatus.COLLECTING;
    }

    this.restingWindows.push({
      timestamp,
      hr,
      sdnn,
      lnSdnn: Math.log(sdnn)
    });

    this.validWindowsCount = this.restingWindows.length;
    this.lastUpdate = timestamp;

    // Расчет прошедших дней
    const elapsedMs = timestamp - this.startDate;
    this.daysElapsed = Math.max(0, elapsedMs / (1000 * 60 * 60 * 24));

    // Пересчет статистических параметров базовой линии
    this.recalculate();
    return true;
  }

  /**
   * Пересчет параметров HR_0, ln(SDNN_0), sigma_HRV
   */
  recalculate() {
    if (this.restingWindows.length === 0) {
      this.status = BaselineStatus.NOT_STARTED;
      return;
    }

    const hrList = this.restingWindows.map(w => w.hr);
    const lnSdnnList = this.restingWindows.map(w => w.lnSdnn);

    // HR_0 = median(HR)
    this.hr0 = Math.round(calculateMedian(hrList));

    // ln(SDNN_0) = mean(ln(SDNN))
    this.lnSdnn0 = calculateMean(lnSdnnList);

    // sigma_HRV = std(ln(SDNN))
    if (lnSdnnList.length >= 2) {
      this.sigmaHrv = calculateStd(lnSdnnList, this.lnSdnn0);
      // Если вариативность в выборке нулевая, сохраняем безопасную минимальную пометку
      if (this.sigmaHrv < MODEL_CONFIG.baseline.min_sigma_hrv) {
        this.sigmaHrv = MODEL_CONFIG.baseline.min_sigma_hrv;
      }
    } else {
      this.sigmaHrv = 0; // Недостаточно данных для sigma
    }

    // Определение статуса готовности:
    // Требуется: не менее 7 дней сбора И достаточное количество валидных окон
    const targetDays = MODEL_CONFIG.baseline.collection_days_target; // 7
    const minWindows = MODEL_CONFIG.baseline.min_valid_windows_for_completion; // 14

    if (this.daysElapsed >= targetDays && this.validWindowsCount >= minWindows) {
      this.status = BaselineStatus.READY;
    } else if (this.daysElapsed >= targetDays && this.validWindowsCount < minWindows) {
      this.status = BaselineStatus.INSUFFICIENT;
    } else {
      this.status = BaselineStatus.COLLECTING;
    }
  }

  /**
   * Возвращает данные базовой линии для модели
   */
  getBaseline() {
    return {
      isReady: this.status === BaselineStatus.READY,
      status: this.status,
      hr0: this.hr0,
      lnSdnn0: this.lnSdnn0,
      sigmaHrv: this.sigmaHrv,
      daysElapsed: this.daysElapsed,
      validWindowsCount: this.validWindowsCount,
      targetDays: MODEL_CONFIG.baseline.collection_days_target,
      statusText: this.getStatusText()
    };
  }

  getStatusText() {
    switch (this.status) {
      case BaselineStatus.READY:
        return 'Базовая линия построена (7 дней)';
      case BaselineStatus.COLLECTING:
        return `Сбор базовой линии (день ${Math.min(7, Math.floor(this.daysElapsed) + 1)} из 7, окон: ${this.validWindowsCount})`;
      case BaselineStatus.INSUFFICIENT:
        return 'Недостаточно валидных замеров за 7 дней';
      case BaselineStatus.NOT_STARTED:
      default:
        return 'Сбор данных не начат';
    }
  }

  /**
   * Сериализация в объект для localStorage
   */
  toJSON() {
    return {
      version: this.version,
      status: this.status,
      hr0: this.hr0,
      lnSdnn0: this.lnSdnn0,
      sigmaHrv: this.sigmaHrv,
      startDate: this.startDate,
      lastUpdate: this.lastUpdate,
      daysElapsed: this.daysElapsed,
      validWindowsCount: this.validWindowsCount,
      // Сохраняем последние 200 окон для экономии места
      restingWindows: this.restingWindows.slice(-200)
    };
  }

  /**
   * Десериализация
   */
  load(data) {
    if (!data) return;
    this.status = data.status || BaselineStatus.NOT_STARTED;
    if (typeof data.hr0 === 'number') this.hr0 = data.hr0;
    if (typeof data.lnSdnn0 === 'number') this.lnSdnn0 = data.lnSdnn0;
    if (typeof data.sigmaHrv === 'number') this.sigmaHrv = data.sigmaHrv;
    this.startDate = data.startDate || null;
    this.lastUpdate = data.lastUpdate || null;
    this.daysElapsed = data.daysElapsed || 0;
    this.validWindowsCount = data.validWindowsCount || 0;
    this.restingWindows = Array.isArray(data.restingWindows) ? data.restingWindows : [];
  }

  reset() {
    this.status = BaselineStatus.NOT_STARTED;
    this.hr0 = 70;
    this.lnSdnn0 = 3.8;
    this.sigmaHrv = 0.35;
    this.startDate = null;
    this.lastUpdate = null;
    this.daysElapsed = 0;
    this.validWindowsCount = 0;
    this.restingWindows = [];
  }
}
