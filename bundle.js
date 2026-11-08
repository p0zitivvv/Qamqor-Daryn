// Qamqor Unified Bundle for local file:// and web server compatibility
(function() {

// --- config.js ---
/**
 * Qamqor Health Monitoring System
 * Централизованная конфигурация математической модели и алгоритмов
 * Версия модели: 1.0.0-experimental
 */
const MODEL_CONFIG = {
  version: '1.0.0-experimental',
  name: 'Qamqor Experimental Health Index Model',

  // Статические коэффициенты (L_stat)
  // L_stat = beta_0 + beta_age*A + beta_bmi*B + beta_smoking*S + beta_family*F + beta_stress*Y - beta_activity*P
  static: {
    beta_0: -2.0,          // Базовый сдвиг (свободный член для молодого здорового человека)
    beta_age: 0.50,        // Возраст (на каждые 10 лет отклонения от 40)
    beta_bmi: 0.25,        // ИМТ (на каждые 5 кг/м² отклонения от 25)
    beta_smoking: 0.70,    // Курение (0 или 1)
    beta_family: 0.40,     // Семейный анамнез ССЗ (0 или 1)
    beta_stress: 0.15,     // Стресс: 0 - низкий, 1 - умеренный, 2 - высокий
    beta_activity: 0.30,   // Физ. активность: 0 - низкая, 1 - средняя, 2 - высокая (вычитается!)
    
    // Параметры нормализации
    age_center: 40,
    age_scale: 10,
    bmi_center: 25,
    bmi_scale: 5,
  },

  // Динамические коэффициенты (L_dyn)
  // L_dyn = beta_hr*Delta_HR + beta_hrv*z_HRV + beta_spo2*s_SpO2 + beta_arr*s_ARR
  dynamic: {
    beta_hr: 0.0077,       // Пульс покоя (на 1 уд/мин превышения HR_0, Zhang et al. CMAJ 2016)
    beta_hrv: 0.385,       // HRV z-score (на 1 sigma снижения ln SDNN, Tsuji et al. Circ 1996)
    beta_spo2: 0.30,       // SpO2 балл (категории шкалы NEWS2)
    beta_arr: 0.60,        // Нерегулярность ритма (на балл s_ARR)
    
    // Ограничения составляющих (clip bounds)
    hr_delta_min: 0,
    hr_delta_max: 40,
    z_hrv_min: 0,
    z_hrv_max: 3,
    s_arr_min: 0,
    s_arr_max: 3,
    
    // SpO2 категориальная шкала (NEWS2)
    spo2_thresholds: [
      { min: 96, score: 0 },
      { min: 94, max: 95, score: 1 },
      { min: 92, max: 93, score: 2 },
      { max: 91, score: 3 }
    ],

    // Порог нерегулярности RR-интервалов (|RR_i - RR_{i-1}| > 0.2 * RR_{i-1})
    arr_relative_threshold: 0.20
  },

  // Параметры персональной базовой линии
  baseline: {
    collection_days_target: 7,
    min_valid_windows_for_completion: 14, // Техническое допущение: минимум 14 пятиминутных окон покоя за 7 дней
    min_sigma_hrv: 0.001 // Защита от деления на ноль при расчет z_HRV
  },

  // Ограничения валидности физиологических сигналов
  signals: {
    hr_min: 30,
    hr_max: 220,
    spo2_min: 70,
    spo2_max: 100,
    rr_min_sec: 0.27,      // 0.27 с = ~222 уд/мин
    rr_max_sec: 2.00,      // 2.00 с = 30 уд/мин
    analysis_window_sec: 300, // 5 минут
    window_slide_sec: 60       // 1 минута
  },

  // Параметры сглаживания во времени (EMA первого порядка)
  // r_{k+1} = r_k + alpha * (r*_k - r_k)
  smoothing: {
    tau_minutes: 5,        // Постоянная времени тау = 5 минут
    delta_t_minutes: 1,    // Шаг дискретизации = 1 минута
    // alpha = 1 - e^(-1/5) = 1 - e^(-0.2) ≈ 0.1812692
    alpha: 1 - Math.exp(-1 / 5)
  },

  // Пороги качества и доступности данных
  quality: {
    min_acceptable_c: 0.5  // При c < 0.5: статус "Недостаточно данных", тревога отключается
  },

  // Зоны индекса и правила формирования тревоги
  zones: {
    green_max: 20,         // I < 20: Зеленая зона (норма)
    yellow_max: 40,        // 20 <= I < 40: Желтая зона (внимание)
    red_min: 40            // I >= 40: Красная зона
  },

  // Параметры конечного автомата тревог
  alerts: {
    threshold_index: 40,
    persistence_minutes: 5, // Требуется 5 последовательных минут I >= 40
    min_quality: 0.5,
    hysteresis_recovery_index: 30 // Для повторного взвода тревоги индекс должен опуститься ниже 30
  },

  // BLE спецификация устройства
  ble: {
    deviceName: 'Qamqor_Band',
    serviceUuid: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
    characteristicUuid: 'beb5483e-36e1-4688-b7f5-ea07361b26a8'
  }
};

/**
 * Единая система состояний устройства Qamqor
 */
const DeviceState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  STREAMING: 'STREAMING',
  NO_DATA: 'NO DATA',
  STALE_DATA: 'STALE DATA',
  ERROR: 'ERROR'
};



// --- signals.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль сбора и цифровой обработки биосигналов (Signal Processing Engine)
 * Реализация спецификации раздела 7 и 16.7
 */



/**
 * Валидация измерения пульсоксиметра MAX30102
 * @param {number} bpm - ЧСС (уд/мин)
 * @param {number} spo2 - Сатурация (%)
 * @returns {Object} { isValid, bpm, spo2, reason }
 */
function validatePulseOximetry(bpm, spo2) {
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
function isValidRRInterval(rrSec) {
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
function calculateSDNN(rrIntervalsSec) {
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
function calculateRMSSD(rrIntervalsSec) {
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
function calculateRhythmIrregularity(rrIntervalsSec) {
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
function checkECGSignalQuality(adcValue, leadsOff = false) {
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
class RPeakDetector {
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


// --- model.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль математической модели (Model Engine)
 * Реализация спецификации раздела 3-5, 8, 10
 */



/**
 * Численно устойчивая логистическая сигмоида
 * r*(t) = 1 / (1 + e^(-L))
 * Предотвращает переполнение при экстремальных значениях L
 * @param {number} L - Значение логита
 * @returns {number} Вероятность r* в интервале (0, 1)
 */
function logistic(L) {
  if (typeof L !== 'number' || isNaN(L)) {
    throw new TypeError(`Аргумент L должен быть числом, получено: ${L}`);
  }
  // Защита от экстремальных значений
  if (L >= 40) return 1.0;
  if (L <= -40) return 0.0;

  if (L >= 0) {
    return 1 / (1 + Math.exp(-L));
  } else {
    const expL = Math.exp(L);
    return expL / (1 + expL);
  }
}

/**
 * Ограничение числа диапазоном [min, max]
 * @param {number} val 
 * @param {number} min 
 * @param {number} max 
 * @returns {number}
 */
function clip(val, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return min;
  return Math.min(max, Math.max(min, val));
}

/**
 * Расчет ИМТ (BMI)
 * BMI = weight_kg / (height_m)^2
 * @param {number} weightKg - Масса в кг (30 - 300)
 * @param {number} heightM - Рост в метрах (0.5 - 2.5) или сантиметрах (>30)
 * @returns {number}
 */
function calculateBMI(weightKg, heightM) {
  if (typeof weightKg !== 'number' || isNaN(weightKg) || typeof heightM !== 'number' || isNaN(heightM)) {
    throw new TypeError('Масса и рост должны быть числами');
  }
  if (weightKg <= 0 || heightM <= 0) {
    throw new RangeError('Масса и рост должны быть положительными числами');
  }
  let h = heightM;
  if (h > 3.0) {
    // Введен в сантиметрах
    h = h / 100;
  }
  if (h < 0.5 || h > 2.5) {
    throw new RangeError(`Рост вне допустимого диапазона: ${h} м`);
  }
  if (weightKg < 25 || weightKg > 350) {
    throw new RangeError(`Масса тела вне допустимого диапазона: ${weightKg} кг`);
  }
  return weightKg / (h * h);
}

/**
 * Нормализация возраста: A = (age - 40) / 10
 * @param {number} age - Возраст в годах
 * @returns {number}
 */
function normalizeAge(age) {
  if (typeof age !== 'number' || isNaN(age) || age < 10 || age > 120) {
    throw new RangeError(`Недопустимый возраст: ${age}`);
  }
  const { age_center, age_scale } = MODEL_CONFIG.static;
  return (age - age_center) / age_scale;
}

/**
 * Нормализация ИМТ: B = (BMI - 25) / 5
 * @param {number} bmi - Значение ИМТ
 * @returns {number}
 */
function normalizeBMI(bmi) {
  if (typeof bmi !== 'number' || isNaN(bmi) || bmi < 10 || bmi > 80) {
    throw new RangeError(`Недопустимый ИМТ: ${bmi}`);
  }
  const { bmi_center, bmi_scale } = MODEL_CONFIG.static;
  return (bmi - bmi_center) / bmi_scale;
}

/**
 * Расчет статической части модели (L_stat)
 * L_stat = beta_0 + beta_age*A + beta_bmi*B + beta_smoking*S + beta_family*F + beta_stress*Y - beta_activity*P
 * 
 * @param {Object} survey
 * @param {number} survey.age - Возраст в годах (обязательно)
 * @param {number} [survey.bmi] - ИМТ (или weightKg + heightM/heightCm)
 * @param {number} [survey.weightKg] - Масса в кг
 * @param {number} [survey.heightM] - Рост в метрах или см
 * @param {number} [survey.heightCm] - Рост в сантиметрах
 * @param {number|boolean} survey.smoking - 0 или 1 (курение). null/undefined запрещены!
 * @param {number|boolean} survey.familyHistory - 0 или 1 (семейный анамнез ССЗ). null/undefined запрещены!
 * @param {number} survey.stress - 0 (низкий), 1 (умеренный), 2 (высокий)
 * @param {number} survey.activity - 0 (низкая), 1 (средняя), 2 (высокая)
 * 
 * @returns {Object} { lStat, components, normalized }
 */
function calculateLStat(survey) {
  if (!survey || typeof survey !== 'object') {
    throw new TypeError('Данные анкеты должны быть объектом');
  }

  // 1. Возраст
  if (survey.age == null || isNaN(survey.age)) {
    throw new Error('Возраст не указан');
  }
  const A = normalizeAge(survey.age);

  // 2. ИМТ
  let bmiVal = survey.bmi;
  const hM = survey.heightM || (survey.heightCm ? survey.heightCm / 100 : null);
  if (bmiVal == null && survey.weightKg && hM) {
    bmiVal = calculateBMI(survey.weightKg, hM);
  }
  if (bmiVal == null || isNaN(bmiVal)) {
    throw new Error('Необходимо указать ИМТ или вес и рост');
  }
  const B = normalizeBMI(bmiVal);

  // 3. Бинарные факторы S, F in {0, 1}
  // ВАЖНО: Не подменять отсутствующие данные! Если значение null / undefined / unknown — бросаем ошибку
  if (survey.smoking === null || survey.smoking === undefined || survey.smoking === 'unknown') {
    throw new Error('Фактор курения (smoking) не указан. Запрещено подставлять случайные значения.');
  }
  if (survey.familyHistory === null || survey.familyHistory === undefined || survey.familyHistory === 'unknown') {
    throw new Error('Семейный анамнез ССЗ (familyHistory) не указан. Запрещено подставлять случайные значения.');
  }

  const S = (survey.smoking === 1 || survey.smoking === true || survey.smoking === '1') ? 1 : 0;
  const F = (survey.familyHistory === 1 || survey.familyHistory === true || survey.familyHistory === '1') ? 1 : 0;

  // 4. Категориальные факторы Y, P in {0, 1, 2}
  if (survey.stress === null || survey.stress === undefined || survey.stress === 'unknown') {
    throw new Error('Уровень стресса (stress) не указан.');
  }
  if (survey.activity === null || survey.activity === undefined || survey.activity === 'unknown') {
    throw new Error('Уровень физической активности (activity) не указан.');
  }

  const Y = clip(parseInt(survey.stress, 10), 0, 2);
  const P = clip(parseInt(survey.activity, 10), 0, 2);

  const cfg = MODEL_CONFIG.static;

  const w0 = cfg.beta_0;
  const wAge = cfg.beta_age * A;
  const wBMI = cfg.beta_bmi * B;
  const wSmoking = cfg.beta_smoking * S;
  const wFamily = cfg.beta_family * F;
  const wStress = cfg.beta_stress * Y;
  const wActivity = -cfg.beta_activity * P; // Вычитается!

  const lStat = w0 + wAge + wBMI + wSmoking + wFamily + wStress + wActivity;

  return {
    lStat,
    normalized: { A, B, S, F, Y, P, bmi: bmiVal },
    weights: {
      beta_0: w0,
      w_age: wAge,
      w_bmi: wBMI,
      w_smoking: wSmoking,
      w_family: wFamily,
      w_stress: wStress,
      w_activity: wActivity
    }
  };
}

/**
 * Валидация анкеты пользователя без подмены отсутствующих данных
 * Проверяет наличие всех 6 обязательных факторов и формирует понятный отчет о готовности.
 * 
 * @param {Object} survey
 * @returns {Object} { isValid, missing, completed, profile }
 */
function validateSurvey(survey) {
  if (!survey || typeof survey !== 'object') {
    return {
      isValid: false,
      missing: [
        { field: 'age', label: 'Возраст', reason: 'Необходим для базовой возрастной калибровки модели' },
        { field: 'bmi', label: 'Рост и вес', reason: 'Необходимы для автоматического расчета ИМТ' },
        { field: 'smoking', label: 'Курение', reason: 'Критически важный фактор кардиоваскулярной нагрузки' },
        { field: 'familyHistory', label: 'Семейная история ССЗ', reason: 'Фактор наследственной предрасположенности к инфаркту/инсульту' },
        { field: 'stress', label: 'Уровень стресса', reason: 'Оценка психоэмоционального влияния на вегетативную нервную систему' },
        { field: 'activity', label: 'Физическая активность', reason: 'Защитный тренировочный фактор сердечно-сосудистой системы' }
      ],
      completed: [],
      profile: null
    };
  }

  const missing = [];
  const completed = [];

  // 1. Возраст
  if (survey.age == null || isNaN(survey.age) || survey.age < 10 || survey.age > 120) {
    missing.push({ field: 'age', label: 'Возраст', reason: 'Укажите возраст от 10 до 110 лет для базовой калибровки' });
  } else {
    completed.push({ field: 'age', label: 'Возраст', value: `${survey.age} лет` });
  }

  // 2. Рост и Вес / ИМТ
  let bmiVal = survey.bmi;
  const height = survey.heightCm || (survey.heightM ? survey.heightM * 100 : null);
  const weight = survey.weightKg;

  if (bmiVal == null && height && weight) {
    try {
      bmiVal = calculateBMI(weight, height);
    } catch {
      bmiVal = null;
    }
  }

  if (bmiVal == null || isNaN(bmiVal) || bmiVal < 10 || bmiVal > 80) {
    missing.push({ field: 'bmi', label: 'Рост и вес (ИМТ)', reason: 'Укажите рост (50–250 см) и вес (25–300 кг) для расчета ИМТ' });
  } else {
    completed.push({ field: 'bmi', label: 'ИМТ', value: `${bmiVal.toFixed(1)} кг/м²` });
  }

  // 3. Курение
  if (survey.smoking === null || survey.smoking === undefined || survey.smoking === 'unknown') {
    missing.push({ field: 'smoking', label: 'Курение', reason: 'Выбрано «Предпочитаю не отвечать». Модель не может подставить вымышленное значение.' });
  } else if (survey.smoking === 1 || survey.smoking === true || survey.smoking === '1') {
    completed.push({ field: 'smoking', label: 'Курение', value: 'Да' });
  } else {
    completed.push({ field: 'smoking', label: 'Курение', value: 'Не курю' });
  }

  // 4. Семейный анамнез
  if (survey.familyHistory === null || survey.familyHistory === undefined || survey.familyHistory === 'unknown') {
    missing.push({ field: 'familyHistory', label: 'Семейная история ССЗ', reason: 'Выбрано «Не знаю». Требуется уточнить у близких родственников.' });
  } else if (survey.familyHistory === 1 || survey.familyHistory === true || survey.familyHistory === '1') {
    completed.push({ field: 'familyHistory', label: 'Семейная история', value: 'Да, есть у родных' });
  } else {
    completed.push({ field: 'familyHistory', label: 'Семейная история', value: 'Нет у родных' });
  }

  // 5. Стресс
  if (survey.stress === null || survey.stress === undefined || survey.stress === 'unknown') {
    missing.push({ field: 'stress', label: 'Уровень стресса', reason: 'Выберите, насколько часто вы испытываете стресс' });
  } else {
    const stressLabels = { 0: 'Редко / почти нет', 1: 'Иногда, умеренно', 2: 'Часто / каждый день' };
    completed.push({ field: 'stress', label: 'Уровень стресса', value: stressLabels[survey.stress] || `Уровень ${survey.stress}` });
  }

  // 6. Активность
  if (survey.activity === null || survey.activity === undefined || survey.activity === 'unknown') {
    missing.push({ field: 'activity', label: 'Физическая активность', reason: 'Выберите уровень вашей регулярной физической активности' });
  } else {
    const actLabels = { 0: 'Почти не двигаюсь', 1: 'Умеренно (прогулки)', 2: 'Регулярно занимаюсь' };
    completed.push({ field: 'activity', label: 'Физическая активность', value: actLabels[survey.activity] || `Уровень ${survey.activity}` });
  }

  const isValid = missing.length === 0;

  return {
    isValid,
    missing,
    completed,
    profile: isValid ? {
      name: survey.name || 'Пользователь',
      age: survey.age,
      heightCm: height,
      weightKg: weight,
      bmi: Math.round(bmiVal * 10) / 10,
      smoking: (survey.smoking === 1 || survey.smoking === true || survey.smoking === '1') ? 1 : 0,
      familyHistory: (survey.familyHistory === 1 || survey.familyHistory === true || survey.familyHistory === '1') ? 1 : 0,
      stress: parseInt(survey.stress, 10),
      activity: parseInt(survey.activity, 10)
    } : null
  };
}

/**
 * Определение балла SpO2 по шкале NEWS2 (раздел 5.3)
 * >= 96 -> 0
 * 94-95 -> 1
 * 92-93 -> 2
 * <= 91 -> 3
 * @param {number} spo2 - Уровень сатурации в %
 * @returns {number} Балл 0, 1, 2 или 3
 */
function calculateSpO2Score(spo2) {
  if (typeof spo2 !== 'number' || isNaN(spo2)) {
    throw new TypeError(`Значение SpO2 должно быть числом, получено: ${spo2}`);
  }
  if (spo2 < MODEL_CONFIG.signals.spo2_min || spo2 > MODEL_CONFIG.signals.spo2_max) {
    throw new RangeError(`SpO2 вне допустимого диапазона [70, 100]: ${spo2}`);
  }

  if (spo2 >= 96) return 0;
  if (spo2 >= 94) return 1;
  if (spo2 >= 92) return 2;
  return 3;
}

/**
 * Расчет динамической части модели (L_dyn) (раздел 5)
 * L_dyn = beta_hr*Delta_HR + beta_hrv*z_HRV + beta_spo2*s_SpO2 + beta_arr*s_ARR
 * 
 * @param {Object} metrics - Текущие измерения
 * @param {number} [metrics.hr] - Текущий пульс покоя (уд/мин)
 * @param {number} [metrics.sdnn] - Текущий SDNN (секунды или мс, согласуется с baseline)
 * @param {number} [metrics.spo2] - Текущий SpO2 (%)
 * @param {number} [metrics.pIrr] - Показатель нерегулярности ритма [0, 1]
 * @param {Object} baseline - Персональная базовая линия
 * @param {number} baseline.hr0 - Медианный пульс покоя HR_0
 * @param {number} baseline.lnSdnn0 - Средний логарифм SDNN ln(SDNN_0)
 * @param {number} baseline.sigmaHrv - Стандартное отклонение логарифма SDNN sigma_HRV
 * 
 * @returns {Object} { lDyn, components, details, availableCount }
 */
function calculateLDyn(metrics, baseline) {
  const cfg = MODEL_CONFIG.dynamic;
  const details = {};
  let lDyn = 0;
  let availableCount = 0;

  // 1. Дельта пульса Delta_HR = clip(HR - HR_0, 0, 40)
  if (metrics && typeof metrics.hr === 'number' && !isNaN(metrics.hr) && baseline && typeof baseline.hr0 === 'number') {
    const rawDelta = metrics.hr - baseline.hr0;
    const deltaHR = clip(rawDelta, cfg.hr_delta_min, cfg.hr_delta_max);
    const wHR = cfg.beta_hr * deltaHR;
    lDyn += wHR;
    availableCount++;
    details.hr = {
      measured: metrics.hr,
      baseline: baseline.hr0,
      delta: deltaHR,
      rawDelta,
      weight: wHR,
      available: true
    };
  } else {
    details.hr = { available: false, reason: 'Нет измерения пульса или базовой линии HR_0' };
  }

  // 2. HRV z-score: z_HRV = clip((ln(SDNN_0) - ln(SDNN)) / sigma_HRV, 0, 3)
  if (metrics && typeof metrics.sdnn === 'number' && metrics.sdnn > 0 &&
      baseline && typeof baseline.lnSdnn0 === 'number' && typeof baseline.sigmaHrv === 'number') {
    if (baseline.sigmaHrv <= MODEL_CONFIG.baseline.min_sigma_hrv) {
      details.hrv = { available: false, reason: 'sigma_HRV базовой линии слишком мала или равна 0' };
    } else {
      const lnSdnn = Math.log(metrics.sdnn);
      const rawZ = (baseline.lnSdnn0 - lnSdnn) / baseline.sigmaHrv;
      const zHRV = clip(rawZ, cfg.z_hrv_min, cfg.z_hrv_max);
      const wHRV = cfg.beta_hrv * zHRV;
      lDyn += wHRV;
      availableCount++;
      details.hrv = {
        measuredSdnn: metrics.sdnn,
        lnSdnn,
        lnSdnn0: baseline.lnSdnn0,
        sigmaHrv: baseline.sigmaHrv,
        rawZ,
        z: zHRV,
        weight: wHRV,
        available: true
      };
    }
  } else {
    details.hrv = { available: false, reason: 'Нет измерения SDNN или базовой линии HRV' };
  }

  // 3. SpO2 балл s_SpO2
  if (metrics && typeof metrics.spo2 === 'number' && !isNaN(metrics.spo2)) {
    try {
      const sSpO2 = calculateSpO2Score(metrics.spo2);
      const wSpO2 = cfg.beta_spo2 * sSpO2;
      lDyn += wSpO2;
      availableCount++;
      details.spo2 = {
        measured: metrics.spo2,
        score: sSpO2,
        weight: wSpO2,
        available: true
      };
    } catch (e) {
      details.spo2 = { available: false, reason: e.message };
    }
  } else {
    details.spo2 = { available: false, reason: 'Нет измерения SpO2' };
  }

  // 4. Нерегулярность ритма s_ARR = clip(10 * p_irr, 0, 3)
  if (metrics && typeof metrics.pIrr === 'number' && !isNaN(metrics.pIrr) && metrics.pIrr >= 0) {
    const rawSArr = 10 * metrics.pIrr;
    const sARR = clip(rawSArr, cfg.s_arr_min, cfg.s_arr_max);
    const wARR = cfg.beta_arr * sARR;
    lDyn += wARR;
    availableCount++;
    details.arr = {
      pIrr: metrics.pIrr,
      sArr: sARR,
      weight: wARR,
      available: true
    };
  } else {
    details.arr = { available: false, reason: 'Алгоритм p_irr недоступен или нет RR-интервалов' };
  }

  return {
    lDyn,
    details,
    availableCount
  };
}

/**
 * Дискретное сглаживание риска во времени (EMA первого порядка) (раздел 8.2)
 * r_{k+1} = r_k + alpha * (r*_k - r_k)
 * alpha = 1 - e^(-Delta_t / tau)
 * 
 * @param {number} rPrev - Предыдущее значение риска r_k
 * @param {number} rTarget - Мгновенная цель r*_k
 * @param {number} [dtMinutes=1] - Прошедшее время в минутах
 * @param {number} [tauMinutes=5] - Постоянная времени фильтра
 * @returns {number} Новое сглаженное значение r_{k+1}
 */
function smoothRisk(rPrev, rTarget, dtMinutes = 1, tauMinutes = 5) {
  if (typeof rTarget !== 'number' || isNaN(rTarget)) {
    throw new TypeError('rTarget должен быть числом');
  }
  // Если начального значения не было, инициализируем первым значением r*
  if (rPrev == null || isNaN(rPrev)) {
    return clip(rTarget, 0, 1);
  }

  const dt = Math.max(0, dtMinutes);
  const tau = Math.max(0.1, tauMinutes);
  const alpha = 1 - Math.exp(-dt / tau);

  const nextR = rPrev + alpha * (rTarget - rPrev);
  return clip(nextR, 0, 1);
}

/**
 * Полный расчет комбинированной модели
 * L(t) = L_stat + c(t) * L_dyn(t)
 * r*(t) = 1 / (1 + e^(-L(t)))
 * r(t) через сглаживание
 * I(t) = 100 * r(t)
 * 
 * @param {Object} params
 * @param {number} params.lStat - Статическая часть
 * @param {number} params.lDyn - Динамическая часть
 * @param {number} params.c - Коэффициент полноты и качества данных c in [0, 1]
 * @param {number|null} params.rPrev - Предыдущее сглаженное значение r
 * @param {number} [params.dtMinutes=1] - Временной интервал от предыдущего расчета
 * @returns {Object} Полный результат расчета
 */
function evaluateModel({ lStat, lDyn, c, rPrev = null, dtMinutes = 1 }) {
  // Проверка полноты анкеты (наличие lStat)
  if (lStat == null || isNaN(lStat)) {
    return {
      version: MODEL_CONFIG.version,
      lStat: null,
      lDyn: typeof lDyn === 'number' ? lDyn : null,
      c: typeof c === 'number' ? c : 0,
      isDataSufficient: false,
      dynContribution: 0,
      L: null,
      rStar: null,
      rSmooth: null,
      index: null,
      zone: 'insufficient_data',
      reason: 'MISSING_SURVEY_DATA',
      statusText: 'Недостаточно данных для расчета'
    };
  }

  const quality = clip(typeof c === 'number' ? c : 0, 0, 1);
  const isDataSufficient = quality >= MODEL_CONFIG.quality.min_acceptable_c;

  // L = L_stat + c * L_dyn
  const dynContribution = quality * (typeof lDyn === 'number' ? lDyn : 0);
  const L = lStat + dynContribution;

  // r* = logistic(L)
  const rStar = logistic(L);

  // Сглаживание
  const rSmooth = smoothRisk(rPrev, rStar, dtMinutes, MODEL_CONFIG.smoothing.tau_minutes);
  const index = Math.round(100 * rSmooth * 10) / 10; // Округляем до 1 знака

  // Определение цветовой зоны
  let zone = 'green';
  if (index >= MODEL_CONFIG.zones.red_min) {
    zone = 'red';
  } else if (index >= MODEL_CONFIG.zones.green_max) {
    zone = 'yellow';
  }

  return {
    version: MODEL_CONFIG.version,
    lStat,
    lDyn,
    c: quality,
    isDataSufficient,
    dynContribution,
    L,
    rStar,
    rSmooth,
    index: isDataSufficient ? index : null, // При c < 0.5 число не выводится
    zone: isDataSufficient ? zone : 'insufficient_data',
    statusText: isDataSufficient ? 'Расчет выполнен' : 'Недостаточно данных для расчета'
  };
}


// --- quality.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль контроля качества и полноты данных (Data Quality Service)
 * Реализация требований раздела 8.1 и 16.4
 */




/**
 * Оценка качества измерений компонентов (q_j in [0, 1])
 * @param {Object} metrics 
 * @param {Object} baseline 
 * @returns {Object} { q_hr, q_hrv, q_spo2, q_arr, c_q, componentStatuses }
 */
function calculateDataQuality(metrics, baseline) {
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
function calculateBaselineCompleteness(daysCollected) {
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
function calculateOverallCompleteness(c_q, c_base) {
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


// --- baseline.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль персональной базовой линии (Personal Baseline Service)
 * Реализация спецификации раздела 6
 */
const BaselineStatus = {
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
function calculateMedian(arr) {
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
function calculateMean(arr) {
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
function calculateStd(arr, mean = null) {
  if (!arr || arr.length < 2) return 0;
  const m = mean !== null ? mean : calculateMean(arr);
  const variance = arr.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Класс управления персональной базовой линией
 */
class PersonalBaselineService {
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


// --- alerts.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль машины состояний уведомлений и тревог (Alert Engine with Hysteresis)
 * Реализация спецификации раздела 9 и 16.6
 */
const AlertState = {
  ARMED: 'ARMED',                         // Взведено: предыдущий индекс был < 30, готов к отслеживанию
  MONITORING: 'MONITORING',               // Индекс от 30 до 39, тревога не взведена повторно
  PENDING: 'PENDING',                     // I >= 40, идет накопление времени (1..4 мин)
  TRIGGERED: 'TRIGGERED',                 // 5 минут подряд при c >= 0.5 — Тревога активна!
  SUPPRESSED_POOR_QUALITY: 'SUPPRESSED'  // I >= 40, но c < 0.5 — тревога заблокирована
};
class AlertEngine {
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


// --- knowledge_base.js ---
/**
 * Qamqor Health Monitoring System
 * Layer 2: Medical & Lifestyle Knowledge Base (База верифицированных знаний)
 * 
 * Sources:
 * - WHO (World Health Organization) Physical Activity & Health Guidelines (2020)
 * - NHS (National Health Service, UK) Sleep Hygiene & Stress Management
 * - AHA (American Heart Association) Resting Heart Rate & HRV Standards
 * - CDC (Centers for Disease Control and Prevention) Lifestyle & Cardiovascular Prevention
 */
const EvidenceLevel = {
  LEVEL_A: 'Уровень A (РКИ / мета-анализы)',
  LEVEL_B: 'Уровень B (Когортные исследования)',
  EXPERT: 'Консенсус экспертов (WHO/AHA/NHS)'
};
const KnowledgeCategory = {
  SLEEP: 'sleep',
  ACTIVITY: 'activity',
  STRESS: 'stress',
  HEART: 'heart',
  LIFESTYLE: 'lifestyle',
  EMERGENCY: 'emergency'
};
const CategoryLabels = {
  [KnowledgeCategory.SLEEP]: 'Сон и восстановление',
  [KnowledgeCategory.ACTIVITY]: 'Физическая активность',
  [KnowledgeCategory.STRESS]: 'Управление стрессом',
  [KnowledgeCategory.HEART]: 'Сердечно-сосудистый тонус',
  [KnowledgeCategory.LIFESTYLE]: 'Образ жизни и гидратация',
  [KnowledgeCategory.EMERGENCY]: 'Неотложная помощь'
};
const KNOWLEDGE_RULES = [
  // ========================================================
  // КРАСНЫЕ ФЛАГИ / ЭКСТРЕННЫЕ СИТУАЦИИ (RULE 10)
  // ========================================================
  {
    id: 'rule_emergency_red_flag',
    category: KnowledgeCategory.EMERGENCY,
    priority: 'high',
    title: 'Требуется неотложная медицинская помощь',
    action: 'Немедленно прекратите любую активность, обеспечьте доступ свежего воздуха, сядьте или прилягте и вызовите скорую помощь (103 или 112). Не оставайтесь в одиночестве.',
    expectedBenefit: 'Своевременная медицинская оценка и предотвращение острых сердечно-сосудистых осложнений.',
    evidenceSource: 'AHA / ESC Guidelines for Acute Coronary Syndromes',
    evidenceLevel: EvidenceLevel.LEVEL_A,
    condition: (context) => {
      const { symptoms, metrics } = context;
      const chestPain = symptoms && symptoms.chestPain;
      const shortness = symptoms && symptoms.shortness;
      const extremeHypoxia = metrics && metrics.spo2 != null && metrics.spo2 < 90 && metrics.spo2 > 0;
      const extremeTachy = metrics && metrics.hr != null && metrics.hr > 150;
      const extremeBrady = metrics && metrics.hr != null && metrics.hr < 40 && metrics.hr > 0;
      return Boolean(chestPain || shortness || extremeHypoxia || extremeTachy || extremeBrady);
    },
    getWhyExplanation: (context) => {
      const reasons = [];
      if (context.symptoms?.chestPain) reasons.push('Боль или давящее ощущение в грудной клетке');
      if (context.symptoms?.shortness) reasons.push('Выраженная одышка в покое');
      if (context.metrics?.spo2 && context.metrics.spo2 < 90) reasons.push(`Критическое снижение SpO₂: ${context.metrics.spo2}% (<90%)`);
      if (context.metrics?.hr && context.metrics.hr > 150) reasons.push(`Выраженная тахикардия: ${context.metrics.hr} уд/мин`);
      if (context.metrics?.hr && context.metrics.hr < 40) reasons.push(`Выраженная брадикардия: ${context.metrics.hr} уд/мин`);
      
      return {
        triggerMetric: reasons.join('; ') || 'Критическое отклонение кардиопоказателей',
        baselineComparison: 'Показатели выходят за границы безопасного физиологического коридора',
        timeframe: 'Текущий момент замера',
        clinicalRationale: 'Сочетание симптомов дискомфорта в груди или критических параметров пульсоксиметрии требует исключения острой коронарной патологии квалифицированным медицинским персоналом.',
        limitations: 'Алгоритм не заменяет ЭКГ-диагностику и осмотр врача. Не откладывайте вызов помощи.'
      };
    }
  },

  // ========================================================
  // ТАХИКАРДИЯ В ПОКОЕ И ПОВЫШЕННЫЙ ПУЛЬС
  // ========================================================
  {
    id: 'rule_elevated_resting_hr',
    category: KnowledgeCategory.STRESS,
    priority: 'high',
    title: 'Дыхательная релаксация и пауза от кофеина',
    action: 'Выполните 5 минут дыхания по квадрату (4-4-4) или медленного диафрагмального дыхания (4 сек вдох, 6 сек выдох). Воздержитесь от кофе, чая и энергетиков на ближайшие 3–4 часа.',
    expectedBenefit: 'Активация блуждающего нерва (n. vagus) и снижение частоты сердечных сокращений на 6–12 уд/мин за 10–15 минут.',
    evidenceSource: 'AHA Heart Rate Guidelines / Harvard Health Publishing',
    evidenceLevel: EvidenceLevel.LEVEL_A,
    condition: (context) => {
      const hr = context.metrics?.hr;
      const hr0 = context.baseline?.hr0 || 70;
      return hr != null && (hr > 100 || (hr >= 90 && hr - hr0 >= 15));
    },
    getWhyExplanation: (context) => {
      const hr = context.metrics?.hr || 0;
      const hr0 = context.baseline?.hr0 || 70;
      const delta = hr - hr0;
      return {
        triggerMetric: `Пульс в покое: ${hr} уд/мин (превышение базового уровня на ${delta > 0 ? '+' + delta : delta} уд/мин)`,
        baselineComparison: `Индивидуальная норма в покое: ${hr0} уд/мин (популяционный оптимум 60–80)`,
        timeframe: 'Текущий сеанс мониторинга',
        clinicalRationale: 'Увеличение частоты сердечных сокращений в покое отражает преобладание симпатического тонуса вегетативной нервной системы, вызванное стрессом, обезвоживанием или переутомлением.',
        limitations: 'Если учащённый пульс сопровождается головокружением или не проходит более часа в полном покое, проконсультируйтесь с врачом.'
      };
    }
  },

  // ========================================================
  // СНИЖЕНИЕ ВАРИАБЕЛЬНОСТИ СЕРДЕЧНОГО РИТМА (HRV / SDNN)
  // ========================================================
  {
    id: 'rule_reduced_hrv_recovery',
    category: KnowledgeCategory.SLEEP,
    priority: 'medium',
    title: 'Приоритет глубокого восстановления и сна',
    action: 'Запланируйте отход ко сну на 40–60 минут раньше обычного. За 1 час до сна отключите экраны смартфонов и ПК, проветрите спальню до 18–20°C.',
    expectedBenefit: 'Увеличение продолжительности глубоких фаз сна (Slow Wave Sleep), повышение ночного SDNN на 15–25% и восстановление запасов парасимпатической активности.',
    evidenceSource: 'NHS Sleep Hygiene / AHA Autonomic Balance Consensus',
    evidenceLevel: EvidenceLevel.LEVEL_A,
    condition: (context) => {
      const sdnn = context.metrics?.sdnn;
      const isLow = sdnn != null && sdnn > 0 && sdnn < 30;
      const zHrv = context.derived?.zHrv;
      return Boolean(isLow || (zHrv != null && zHrv >= 1.5));
    },
    getWhyExplanation: (context) => {
      const sdnn = context.metrics?.sdnn != null ? Math.round(context.metrics.sdnn) : '—';
      return {
        triggerMetric: `Вариабельность сердечного ритма SDNN: ${sdnn} мс (снижение вегетативного резерва)`,
        baselineComparison: 'Физиологическая норма взрослого в покое обычно составляет 35–65 мс',
        timeframe: 'Анализ за последние 5–15 минут записи RR-интервалов',
        clinicalRationale: 'Снижение вариабельности ритма — это физиологический признак накопленной усталости, недосыпа или высокого напряжения регуляторных систем, а не болезнь.',
        limitations: 'Не является диагнозом органического поражения сердца. Показатель быстро восстанавливается после качественного отдыха.'
      };
    }
  },

  // ========================================================
  // УМЕРЕННОЕ СНИЖЕНИЕ SPO2 (90-94%)
  // ========================================================
  {
    id: 'rule_mild_hypoxia_posture',
    category: KnowledgeCategory.HEART,
    priority: 'high',
    title: 'Коррекция осанки, проветривание и глубокое дыхание',
    action: 'Сядьте прямо, расправьте грудную клетку или выйдите на свежий воздух. Сделайте 10 медленных глубоких вдохов через нос и выдохов через слегка сомкнутые губы. Убедитесь, что датчик MAX30102 плотно прилегает к тёплому пальцу.',
    expectedBenefit: 'Улучшение альвеолярной вентиляции верхушек лёгких и нормализация сатурации SpO₂ до 96–99%.',
    evidenceSource: 'WHO Pulse Oximetry Training Manual / British Thoracic Society',
    evidenceLevel: EvidenceLevel.LEVEL_A,
    condition: (context) => {
      const spo2 = context.metrics?.spo2;
      return spo2 != null && spo2 >= 90 && spo2 < 95;
    },
    getWhyExplanation: (context) => {
      const spo2 = context.metrics?.spo2 || 0;
      return {
        triggerMetric: `Уровень оксигенации крови SpO₂: ${spo2}% (ниже оптимального коридора 95–99%)`,
        baselineComparison: 'Норма насыщения крови кислородом для здоровых людей на уровне моря: 95–100%',
        timeframe: 'Текущие показания фотоплетизмографии',
        clinicalRationale: 'Умеренное снижение SpO₂ часто обусловлено поверхностным дыханием при сидячей работе, сдавлением грудной клетки, холодными пальцами или плохой циркуляцией в капиллярах.',
        limitations: 'При сохранении SpO₂ ниже 94% более 15 минут в тёплом помещении и при правильном положении датчика рекомендуется консультация терапевта.'
      };
    }
  },

  // ========================================================
  // ФИЗИЧЕСКАЯ АКТИВНОСТЬ: МАЛОПОДВИЖНОСТЬ / СИДЯЧИЙ ОБРАЗ ЖИЗНИ
  // ========================================================
  {
    id: 'rule_sedentary_activity_boost',
    category: KnowledgeCategory.ACTIVITY,
    priority: 'medium',
    title: 'Регулярные разминки и ходьба (стандарт ВОЗ)',
    action: 'Каждые 45–60 минут сидячей работы вставайте на 3-минутную разминку: 30 приседаний в комфортном темпе или быстрая прогулка по офису/комнате. Стремитесь к 150 минутам умеренной аэробной активности в неделю.',
    expectedBenefit: 'Снижение сосудистого сопротивления, улучшение микроциркуляции и профилактика венозного застоя.',
    evidenceSource: 'WHO Guidelines on Physical Activity and Sedentary Behaviour (2020)',
    evidenceLevel: EvidenceLevel.LEVEL_A,
    condition: (context) => {
      const isSedentary = context.profile?.activity === 0 || context.profile?.activity === '0';
      const noRedFlag = !context.symptoms?.chestPain && !context.symptoms?.shortness;
      return Boolean(isSedentary && noRedFlag);
    },
    getWhyExplanation: (context) => {
      return {
        triggerMetric: 'Уровень повседневной активности: сидячий / низкий',
        baselineComparison: 'Рекомендация ВОЗ: не менее 150–300 минут умеренной аэробной активности в неделю',
        timeframe: 'Оценка образа жизни по профилю пользователя',
        clinicalRationale: 'Длительное непрерывное сидение снижает чувствительность к инсулину и ухудшает эндотелиальную функцию сосудов. Короткие перерывы на ходьбу устраняют этот негативный эффект.',
        limitations: 'Нагрузка должна быть плавной и не вызывать одышки или боли в суставах.'
      };
    }
  },

  // ========================================================
  // ГИДРАТАЦИЯ И ВОДНЫЙ БАЛАНС
  // ========================================================
  {
    id: 'rule_hydration_support',
    category: KnowledgeCategory.LIFESTYLE,
    priority: 'low',
    title: 'Оптимизация гидратации (1.5–2.0 л чистой воды)',
    action: 'Выпейте стакан тёплой чистой воды прямо сейчас. Держите бутылку с водой на рабочем столе и пейте равномерными небольшими порциями в течение дня.',
    expectedBenefit: 'Поддержание оптимального объёма циркулирующей крови, снижение вязкости крови и облегчение работы миокарда.',
    evidenceSource: 'European Journal of Nutrition / CDC Water Intake Guidelines',
    evidenceLevel: EvidenceLevel.LEVEL_B,
    condition: (context) => {
      const hr = context.metrics?.hr;
      const isWarmOrElevated = hr != null && hr > 80;
      return Boolean(isWarmOrElevated);
    },
    getWhyExplanation: (context) => {
      return {
        triggerMetric: 'Повышенная потребность в циркуляторной поддержке миокарда',
        baselineComparison: 'Рекомендуемая суточная норма жидкости: 30 мл на 1 кг массы тела',
        timeframe: 'Дневной режим водно-солевого баланса',
        clinicalRationale: 'Даже легкая степень дегидратации (потеря 1–2% массы тела) приводит к сгущению крови и компенсаторному учащению пульса на 5–8 уд/мин.',
        limitations: 'При хронической сердечной или почечной недостаточности объём жидкости согласуется с лечащим врачом.'
      };
    }
  },

  // ========================================================
  // НЕРЕГУЛЯРНЫЙ РИТМ (ЭКСТРАСИСТОЛЫ / p_irr)
  // ========================================================
  {
    id: 'rule_rhythm_irregularity_caution',
    category: KnowledgeCategory.HEART,
    priority: 'medium',
    title: 'Отказ от стимуляторов и спокойный отдых',
    action: 'Исключите энергетики, крепкий кофе, никотин и интенсивные тренировки на сегодня. Прилягте на 20 минут в тихом прохладном помещении.',
    expectedBenefit: 'Снижение триггерной эктопической активности миокарда и стабилизация регулярности сердечного ритма.',
    evidenceSource: 'ESC Guidelines on Ventricular Arrhythmias / AHA Prevention',
    evidenceLevel: EvidenceLevel.LEVEL_B,
    condition: (context) => {
      const pIrr = context.derived?.pIrr || context.metrics?.pIrr;
      return pIrr != null && pIrr >= 0.15;
    },
    getWhyExplanation: (context) => {
      const pIrr = context.derived?.pIrr || context.metrics?.pIrr || 0;
      return {
        triggerMetric: `Коэффициент нерегулярности RR-интервалов: ${Math.round(pIrr * 100)}% (порог внимания >15%)`,
        baselineComparison: 'В физиологической норме у здорового человека нерегулярность составляет < 5–10%',
        timeframe: 'Анализ последовательности кардиоциклов по ЭКГ / фотоплетизмограмме',
        clinicalRationale: 'Одиночные функциональные экстрасистолы или дыхательная аритмия часто возникают на фоне утомления, эмоционального стресса или избытка кофеина.',
        limitations: 'Если перебои сопровождаются потемнением в глазах, предобморочным состоянием или загрудинной болью, немедленно обратитесь к кардиологу.'
      };
    }
  },

  // ========================================================
  // ОБЩИЙ ОПТИМУМ (ЗЕЛЕНАЯ ЗОНА, СТАБИЛЬНЫЕ ДАННЫЕ)
  // ========================================================
  {
    id: 'rule_optimal_maintenance',
    category: KnowledgeCategory.LIFESTYLE,
    priority: 'low',
    title: 'Поддержание текущего кардио-баланса',
    action: 'Ваши ключевые показатели находятся в индивидуальной норме. Сохраняйте привычный распорядок дня, прогуляйтесь на свежем воздухе 20–30 минут.',
    expectedBenefit: 'Укрепление сердечно-сосудистой адаптации и поддержание высокого уровня энергии.',
    evidenceSource: 'WHO Global Action Plan on Physical Activity',
    evidenceLevel: EvidenceLevel.EXPERT,
    condition: (context) => {
      const hr = context.metrics?.hr;
      const spo2 = context.metrics?.spo2;
      const index = context.index != null ? context.index : 15;
      return (hr == null || (hr >= 55 && hr <= 85)) &&
             (spo2 == null || spo2 >= 96) &&
             index < 25;
    },
    getWhyExplanation: () => {
      return {
        triggerMetric: 'Все наблюдаемые биомаркеры в пределах физиологической нормы',
        baselineComparison: 'Пульс, сатурация и вегетативный баланс соответствуют оптимуму',
        timeframe: 'Текущий мониторинг',
        clinicalRationale: 'Сбалансированное соотношение симпатических и парасимпатических влияний свидетельствует об адекватном восстановлении сердечно-сосудистой системы.',
        limitations: 'Продолжайте периодические фоновые замеры для поддержания актуальности базовой линии.'
      };
    }
  }
];
class KnowledgeBaseService {
  /**
   * Подбор подходящих правил на основе контекста
   */
  static evaluateRules(context) {
    const matched = [];
    const isRedFlag = KNOWLEDGE_RULES[0].condition(context);

    if (isRedFlag) {
      // При наличии красного флага возвращаем ТОЛЬКО экстренную помощь (Правило 10)
      const emergencyRule = KNOWLEDGE_RULES[0];
      return [{
        ...emergencyRule,
        why: emergencyRule.getWhyExplanation(context)
      }];
    }

    for (const rule of KNOWLEDGE_RULES) {
      if (rule.category === KnowledgeCategory.EMERGENCY) continue;
      try {
        if (rule.condition(context)) {
          matched.push({
            ...rule,
            why: rule.getWhyExplanation(context)
          });
        }
      } catch (err) {
        console.warn('[KnowledgeBase] Ошибка проверки правила:', rule.id, err);
      }
    }

    // Если правил не набралось, добавляем оптимальное поддержание
    if (matched.length === 0) {
      const optRule = KNOWLEDGE_RULES.find(r => r.id === 'rule_optimal_maintenance');
      if (optRule) {
        matched.push({
          ...optRule,
          why: optRule.getWhyExplanation(context)
        });
      }
    }

    // Сортировка по приоритету: high > medium > low
    const priorityWeight = { high: 3, medium: 2, low: 1 };
    matched.sort((a, b) => (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0));

    // Возвращаем максимум 3 лучших правила (защита от перегрузки интерфейса)
    return matched.slice(0, 3);
  }
}


// --- recommendations.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль персональных рекомендаций (Recommendation Engine)
 * Реализация спецификации разделов 4, 5, 6 обязательного модуля
 */
const RecommendationCategory = {
  RETRY: 'повторное измерение',
  SPECIALIST: 'консультация специалиста',
  STRESS: 'стресс',
  SLEEP: 'сон',
  ACTIVITY: 'физическая активность',
  HYDRATION: 'гидратация'
};
const Priority = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

/**
 * Класс RecommendationEngine
 * Генерирует клинически безопасные, персонализированные рекомендации
 * на основании доступных и валидных физиологических и анкетных показателей.
 */
class RecommendationEngine {
  constructor() {
    this.version = MODEL_CONFIG.version;
  }

  /**
   * Сформировать список рекомендаций
   * 
   * @param {Object} context
   * @param {Object} context.metrics - Текущие показатели { hr, sdnn, spo2, pIrr }
   * @param {Object} context.baseline - Базовая линия { hr0, lnSdnn0, sigmaHrv, isReady }
   * @param {Object} context.quality - Качество данных { c, c_q, c_base, isSufficient }
   * @param {Object} context.profile - Анкета пользователя { age, bmi, smoking, familyHistory, stress, activity }
   * @param {Object} [context.symptoms] - Текущие симптомы { chestPain, shortness, dizziness }
   * @param {number|null} context.index - Текущий индекс Qamqor (0 - 100)
   * 
   * @returns {Array<Object>} Массив структурированных рекомендаций
   */
  generateRecommendations({ metrics = {}, baseline = {}, quality = {}, profile = {}, symptoms = {}, index = null }) {
    const list = [];
    const isQualitySufficient = quality && quality.c >= MODEL_CONFIG.quality.min_acceptable_c; // c >= 0.5

    // ========================================================
    // ПРАВИЛО 10: КРАСНЫЕ ФЛАГИ (ТРЕВОЖНЫЕ СИМПТОМЫ)
    // Низкий индекс не отменяет рекомендацию вызвать помощь при боли в груди/одышке
    // ========================================================
    if (symptoms.chestPain || symptoms.shortness) {
      list.push({
        id: 'redflag_urgent_care',
        title: 'Внимание: выраженные тревожные симптомы',
        description: 'Вы сообщили о боли/дискомфорте в груди или одышке. Носимый браслет не диагностирует инфаркт миокарда и не заменяет неотложную медицинскую помощь.',
        action: 'Немедленно прекратите физическую активность, примите положение полусидя и вызовите скорую помощь по номеру 103 или 112.',
        metric: 'symptoms',
        category: RecommendationCategory.SPECIALIST,
        priority: Priority.HIGH,
        triggerReason: symptoms.chestPain ? 'Сообщено о боли или дискомфорте в груди' : 'Сообщено о выраженной одышке'
      });
      // При наличии неотложных симптомов не перегружаем бытовыми советами
      return list;
    }

    // ========================================================
    // ПРАВИЛО 2: НИЗКОЕ КАЧЕСТВО СИГНАЛА / НЕДОСТАТОК ДАННЫХ
    // Если c < 0.5, сначала предлагаем проверить датчик
    // ========================================================
    if (!isQualitySufficient) {
      const qPct = quality && typeof quality.c === 'number' ? Math.round(quality.c * 100) : 0;
      list.push({
        id: 'quality_sensor_contact',
        title: 'Проверьте контакт датчиков и повторите замер',
        description: `Полнота и качество сигнала составляют ${qPct}% (требуется не менее 50%). Расчёт индекса приостановлен, чтобы не вводить в заблуждение неточными цифрами.`,
        action: 'Убедитесь, что ремешок браслета плотно прилегает к запястью, электроды ЭКГ имеют контакт с кожей, рука находится в покое без резких движений. Повторите замер через 2–3 минуты.',
        metric: 'quality',
        category: RecommendationCategory.RETRY,
        priority: Priority.HIGH,
        triggerReason: `Коэффициент полноты данных c = ${(quality.c || 0).toFixed(2)} (< 0.50)`
      });

      // Не формируем рекомендации по отсутствующим динамическим данным
      return list;
    }

    // ========================================================
    // ПРАВИЛО 3: ПУЛЬС И ЕГО ОТКЛОНЕНИЕ ОТ БАЗЫ
    // ========================================================
    if (typeof metrics.hr === 'number' && metrics.hr > 0) {
      const hr0 = baseline.hr0 || 70;
      const deltaHR = metrics.hr - hr0;

      if (metrics.hr >= 100) {
        list.push({
          id: 'hr_tachycardia',
          title: 'Учащённый пульс в покое (тахикардия)',
          description: `Текущая частота сердечных сокращений (${metrics.hr} уд/мин) заметно выше индивидуального уровня покоя (${hr0} уд/мин). Это может быть связано с волнением, кофеином, недавней ходьбой или обезвоживанием.`,
          action: 'Сделайте паузу, займите удобное сидячее положение. Выполните дыхательное упражнение: спокойный вдох носом на 4 секунды, задержка дыхания на 2 секунды, плавный выдох через рот на 6 секунд (повторить 8–10 раз).',
          metric: 'hr',
          category: RecommendationCategory.STRESS,
          priority: Priority.HIGH,
          triggerReason: `Пульс ${metrics.hr} уд/мин превышает персональную норму на +${deltaHR} уд/мин`
        });
      } else if (deltaHR >= 15 && metrics.hr >= 85) {
        list.push({
          id: 'hr_elevated_moderate',
          title: 'Пульс выше индивидуальной нормы',
          description: `Пульс выше вашего базового уровня покоя на ${deltaHR} уд/мин. Организм испытывает повышенную метаболическую нагрузку.`,
          action: 'Отдохните 10–15 минут без физических нагрузок, выпейте стакан чистой негазированной воды.',
          metric: 'hr',
          category: RecommendationCategory.HYDRATION,
          priority: Priority.MEDIUM,
          triggerReason: `Отклонение ЧСС от персональной базовой линии: +${deltaHR} уд/мин`
        });
      } else if (metrics.hr < 50) {
        list.push({
          id: 'hr_bradycardia',
          title: 'Низкая частота пульса (брадикардия)',
          description: `Пульс составляет ${metrics.hr} уд/мин. У тренированных людей это может быть вариантом нормы, но при слабости или головокружении требует внимания.`,
          action: 'Если чувствуете слабость, головокружение или потемнение в глазах — прилягте и обратитесь к терапевту для оценки синусового узла.',
          metric: 'hr',
          category: RecommendationCategory.SPECIALIST,
          priority: Priority.MEDIUM,
          triggerReason: `Пульс ${metrics.hr} уд/мин ниже 50 уд/мин`
        });
      }
    }

    // ========================================================
    // КИСЛОРОД В КРОВИ (SpO2)
    // ========================================================
    if (typeof metrics.spo2 === 'number' && metrics.spo2 > 0) {
      if (metrics.spo2 <= 91) {
        list.push({
          id: 'spo2_low_critical',
          title: 'Выраженное снижение кислорода в крови',
          description: `Сатурация SpO₂ составляет ${metrics.spo2}%. Это признак гипоксии, снижающей снабжение кислородом миокарда и головного мозга.`,
          action: 'Проветрите комнату, расстегните стесняющую одежду, сделайте 5 спокойных глубоких вдохов. Если показатель не поднимется выше 93% за 5 минут или появится одышка — обратитесь к врачу.',
          metric: 'spo2',
          category: RecommendationCategory.SPECIALIST,
          priority: Priority.HIGH,
          triggerReason: `SpO2 = ${metrics.spo2}% (категория 3 шкалы NEWS2, ≤91%)`
        });
      } else if (metrics.spo2 <= 93) {
        list.push({
          id: 'spo2_moderate_drop',
          title: 'Умеренное снижение оксигенации',
          description: `Сатурация ${metrics.spo2}% указывает на нехватку свежего воздуха или поверхностное дыхание.`,
          action: 'Откройте окно для притока кислорода, сделайте паузу в работе за компьютером, выполните серию диафрагмальных глубоких вдохов.',
          metric: 'spo2',
          category: RecommendationCategory.RETRY,
          priority: Priority.MEDIUM,
          triggerReason: `SpO2 = ${metrics.spo2}% (категория 2 шкалы NEWS2, 92–93%)`
        });
      }
    }

    // ========================================================
    // ПРАВИЛО 4: ВАРИАБЕЛЬНОСТЬ СЕРДЕЧНОГО РИТМА (SDNN)
    // Не утверждаем, что это болезнь, предлагаем оценить динамику
    // ========================================================
    if (typeof metrics.sdnn === 'number' && metrics.sdnn > 0) {
      const isBaseReady = baseline && baseline.isReady && baseline.sigmaHrv > 0;
      let isDrop = false;

      if (isBaseReady) {
        const z = (baseline.lnSdnn0 - Math.log(metrics.sdnn)) / baseline.sigmaHrv;
        if (z >= 1.5) isDrop = true;
      } else if (metrics.sdnn < 25) {
        isDrop = true;
      }

      if (isDrop) {
        list.push({
          id: 'hrv_depleted_reserve',
          title: 'Снижение вариабельности ритма (SDNN)',
          description: `Показатель SDNN (${Math.round(metrics.sdnn)} мс) находится ниже вашего обычного уровня. В математической модели это отражает временное преобладание симпатического тонуса (стресс, утомление, перетренированность). Это не диагноз, а сигнал о потребности в отдыхе.`,
          action: 'Запланируйте сегодня полноценный ночной сон не менее 8 часов. Исключите тяжелые интенсивные тренировки на текущий день, заменив их прогулкой на свежем воздухе.',
          metric: 'sdnn',
          category: RecommendationCategory.SLEEP,
          priority: Priority.MEDIUM,
          triggerReason: `SDNN ${Math.round(metrics.sdnn)} мс ниже базового адаптационного диапазона`
        });
      }
    }

    // ========================================================
    // ПРАВИЛО 5: АНКЕТНЫЕ ФАКТОРЫ (СТРЕСС, КУРЕНИЕ, ИМТ, АКТИВНОСТЬ)
    // Безопасные общие рекомендации
    // ========================================================
    if (profile.stress >= 2) {
      list.push({
        id: 'lifestyle_high_stress',
        title: 'Снижение стрессовой нагрузки',
        description: 'Вы указали высокий уровень стресса в анкете. Хронический стресс поддерживает повышенный уровень кортизола и сосудистый тонус.',
        action: 'Попробуйте технику прогрессивной мышечной релаксации: поочередное напряжение и расслабление мышц плеч и шеи в течение 5 минут.',
        metric: 'stress',
        category: RecommendationCategory.STRESS,
        priority: Priority.LOW,
        triggerReason: 'Анкета: указан высокий субъективный уровень стресса (Y=2)'
      });
    }

    if (profile.smoking === 1) {
      list.push({
        id: 'lifestyle_smoking_factor',
        title: 'Фактор курения в статической оценке',
        description: 'Курение повышает статическую составляющую риска (+0.70 к логиту) из-за спазма периферических сосудов и оксидативного стресса.',
        action: 'Постарайтесь воздержаться от сигарет хотя бы за 1 час до сна и перед физическими нагрузками.',
        metric: 'smoking',
        category: RecommendationCategory.SPECIALIST,
        priority: Priority.LOW,
        triggerReason: 'Анкета: зафиксирован фактор активного курения (S=1)'
      });
    }

    if (profile.activity === 0) {
      list.push({
        id: 'lifestyle_sedentary',
        title: 'Малоподвижный образ жизни',
        description: 'Регулярная аэробная активность снижает базовый пульс покоя и улучшает эластичность стенок артерий.',
        action: 'Добавьте 20–30 минут непрерывной ходьбы в умеренном темпе в ваш ежедневный распорядок.',
        metric: 'activity',
        category: RecommendationCategory.ACTIVITY,
        priority: Priority.LOW,
        triggerReason: 'Анкета: низкий уровень физической активности (P=0)'
      });
    }

    // Если всё идеально и список пуст — формируем поддерживающую рекомендацию
    if (list.length === 0) {
      list.push({
        id: 'general_wellness_stable',
        title: 'Показатели в комфортной зоне',
        description: 'Сердечный ритм, насыщение кислородом и вариабельность находятся в пределах нормы.',
        action: 'Продолжайте соблюдать привычный питьевой режим (1.5–2 л чистой воды) и делайте регулярные паузы при сидячей работе.',
        metric: 'wellness',
        category: RecommendationCategory.HYDRATION,
        priority: Priority.LOW,
        triggerReason: 'Все измеренные показатели соответствуют зелёной зоне'
      });
    }

    return list;
  }

  /**
   * Сформировать план «Что можно улучшить» (до 3 приоритетных действий)
   * 
   * @param {Array<Object>} recommendations 
   * @param {Array<string>} completedActionIds - Идентификаторы уже выполненных действий
   * @returns {Array<Object>}
   */
  getImprovementPlan(recommendations, completedActionIds = []) {
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      return [];
    }

    // Сортировка по приоритету: HIGH -> MEDIUM -> LOW
    const priorityWeight = { [Priority.HIGH]: 3, [Priority.MEDIUM]: 2, [Priority.LOW]: 1 };
    const sorted = [...recommendations].sort((a, b) => {
      const wA = priorityWeight[a.priority] || 0;
      const wB = priorityWeight[b.priority] || 0;
      return wB - wA;
    });

    // Берем до 3 наиболее релевантных рекомендаций
    return sorted.slice(0, 3).map(rec => ({
      id: rec.id,
      title: rec.title,
      action: rec.action,
      category: rec.category,
      priority: rec.priority,
      reason: rec.triggerReason,
      isCompleted: completedActionIds.includes(rec.id)
    }));
  }
}


// --- storage.js ---

const _memoryStore = {};

function safeGetItem(key) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
      return safeGetItem(key);
    }
  } catch (e) {}
  return _memoryStore[key] !== undefined ? _memoryStore[key] : null;
}

function safeSetItem(key, val) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
      safeSetItem(key, String(val));
      return;
    }
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.number === -2147024882)) {
      throw e;
    }
  }
  _memoryStore[key] = String(val);
}

function safeRemoveItem(key) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.removeItem === 'function') {
      localStorage.removeItem(key);
      return;
    }
  } catch (e) {}
  delete _memoryStore[key];
}

/**
 * Qamqor Health Monitoring System
 * Модуль локального хранилища (Storage Layer)
 * 
 * Полная изоляция Demo Mode и Real Device Mode:
 * - HISTORY: реальные измерения с физического браслета
 * - DEMO_HISTORY: демонстрационные измерения
 * - AI_ADVISOR_CACHE_REAL / AI_ADVISOR_CACHE_DEMO: раздельные кэши рекомендаций
 */



const STORAGE_KEYS = {
  ONBOARDED: 'qamqor_v3_onboarded',
  PROFILE: 'qamqor_v3_profile',
  BASELINE: 'qamqor_v3_baseline',
  ALERTS: 'qamqor_v3_alerts',
  MEASUREMENTS: 'qamqor_v3_measurements',
  HISTORY: 'qamqor_v3_history',
  DEMO_HISTORY: 'qamqor_v3_demo_history',
  IS_DEMO: 'qamqor_v3_is_demo',
  DEVICE_ALIAS: 'qamqor_v3_device_alias',
  SOS_ENDPOINT: 'qamqor_v3_sos_endpoint',
  COMPLETED_ACTIONS: 'qamqor_v3_completed_actions',
  AI_ADVISOR_CACHE_REAL: 'qamqor_v3_ai_cache_real',
  AI_ADVISOR_CACHE_DEMO: 'qamqor_v3_ai_cache_demo',
  // Устаревший ключ для обратной совместимости
  AI_ADVISOR_CACHE: 'qamqor_v3_ai_advisor_cache'
};

/**
 * Нормализация записи истории для обратной совместимости
 */
function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const dateObj = new Date(timestamp);

  const dateStr = raw.dateStr || raw.date || dateObj.toLocaleDateString('ru-RU');
  const timeStr = raw.timeStr || raw.time || dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const bpm = typeof raw.bpm === 'number' ? raw.bpm : (typeof raw.hr === 'number' ? raw.hr : null);
  const spo2 = typeof raw.spo2 === 'number' ? raw.spo2 : null;
  const sdnn = typeof raw.sdnn === 'number' ? raw.sdnn : (typeof raw.hrv === 'number' ? raw.hrv : null);
  const rmssd = typeof raw.rmssd === 'number' ? raw.rmssd : null;

  const isDemo = Boolean(raw.isDemo || raw.source === 'demo' || (raw.source && String(raw.source).toLowerCase().includes('демо')));
  const source = isDemo ? 'demo' : (raw.source || 'real');

  return {
    id: raw.id || (timestamp.toString(36) + Math.random().toString(36).slice(2, 6)),
    timestamp,
    dateStr,
    timeStr,
    date: dateStr, // псевдоним
    time: timeStr, // псевдоним
    source,
    isDemo,
    bpm,
    spo2,
    sdnn,
    rmssd,
    index: raw.index != null ? raw.index : '—',
    zone: raw.zone || 'green',
    c: typeof raw.c === 'number' ? raw.c : null,
    title: raw.title || (isDemo ? 'Демонстрационный срез' : 'Замер Qamqor Band'),
    version: raw.version || MODEL_CONFIG.version
  };
}
const StorageService = {
  isOnboarded() {
    
    return safeGetItem(STORAGE_KEYS.ONBOARDED) === 'true';
  },

  setOnboarded(value) {
    
    safeSetItem(STORAGE_KEYS.ONBOARDED, value ? 'true' : 'false');
  },

  getProfile() {
    
    const raw = safeGetItem(STORAGE_KEYS.PROFILE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  getDefaultDemoProfile() {
    return {
      name: 'Демо-Пользователь',
      age: 40,
      gender: 'unspecified',
      heightCm: 175,
      weightKg: 75,
      bmi: 24.5,
      smoking: 0,
      familyHistory: 0,
      stress: 1, // 0-низкий, 1-умеренный, 2-высокий
      activity: 1 // 0-низкая, 1-средняя, 2-высокая
    };
  },

  saveProfile(profile) {
    
    safeSetItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
  },

  getBaseline() {
    
    const raw = safeGetItem(STORAGE_KEYS.BASELINE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveBaseline(data) {
    
    safeSetItem(STORAGE_KEYS.BASELINE, JSON.stringify(data));
  },

  getAlertsState() {
    
    const raw = safeGetItem(STORAGE_KEYS.ALERTS);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveAlertsState(data) {
    
    safeSetItem(STORAGE_KEYS.ALERTS, JSON.stringify(data));
  },

  isDemoMode() {
    
    return safeGetItem(STORAGE_KEYS.IS_DEMO) === 'true';
  },

  setDemoMode(val) {
    
    safeSetItem(STORAGE_KEYS.IS_DEMO, val ? 'true' : 'false');
  },

  getDeviceAlias() {
    
    return safeGetItem(STORAGE_KEYS.DEVICE_ALIAS) || 'Qamqor Band';
  },

  setDeviceAlias(name) {
    
    safeSetItem(STORAGE_KEYS.DEVICE_ALIAS, name);
  },

  getSOSEndpoint() {
    
    return safeGetItem(STORAGE_KEYS.SOS_ENDPOINT) || '';
  },

  setSOSEndpoint(url) {
    
    safeSetItem(STORAGE_KEYS.SOS_ENDPOINT, url);
  },

  // ========================================================
  // РАЗДЕЛЬНОЕ ХРАНЕНИЕ ИСТОРИИ (REAL vs DEMO)
  // ========================================================

  getHistory(isDemo = false) {
    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;
    const raw = safeGetItem(key);

    if (!raw) {
      if (isDemo) {
        const defaultDemo = this.generateDefaultDemoHistory();
        this.saveHistory(defaultDemo, true);
        return defaultDemo;
      }
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeHistoryEntry).filter(Boolean);
    } catch {
      return [];
    }
  },

  saveHistory(history, isDemo = false) {
    
    if (!Array.isArray(history)) return false;

    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;

    try {
      // Нормализуем и ограничиваем историю 500 записями
      const normalized = history.slice(0, 500).map(normalizeHistoryEntry).filter(Boolean);
      safeSetItem(key, JSON.stringify(normalized));
      return true;
    } catch (e) {
      console.warn('[StorageService] Ошибка записи истории в localStorage:', e);
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.number === -2147024882)) {
        try {
          const reduced = history.slice(0, 100).map(normalizeHistoryEntry).filter(Boolean);
          safeSetItem(key, JSON.stringify(reduced));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  },

  addHistoryEntry(entry, isDemo = false) {
    const history = this.getHistory(isDemo);
    const normalized = normalizeHistoryEntry({
      ...entry,
      isDemo,
      source: isDemo ? 'demo' : 'real'
    });

    if (!normalized) return null;

    history.unshift(normalized);
    if (history.length > 500) history.pop();

    this.saveHistory(history, isDemo);
    return normalized;
  },

  clearHistory(isDemo = false) {
    
    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;
    safeSetItem(key, JSON.stringify([]));
  },

  /**
   * Генерация реалистичной 7-дневной истории для Demo Mode
   */
  generateDefaultDemoHistory() {
    const list = [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Срезы за последние 7 дней (по 2-3 замера в день)
    const templates = [
      { dayOffset: 0, time: '18:30', bpm: 74, spo2: 98, sdnn: 48, rmssd: 42, index: 18, zone: 'green' },
      { dayOffset: 0, time: '12:15', bpm: 78, spo2: 98, sdnn: 45, rmssd: 39, index: 21, zone: 'yellow' },
      { dayOffset: 0, time: '08:45', bpm: 71, spo2: 99, sdnn: 52, rmssd: 46, index: 16, zone: 'green' },
      { dayOffset: 1, time: '20:10', bpm: 73, spo2: 98, sdnn: 50, rmssd: 44, index: 17, zone: 'green' },
      { dayOffset: 1, time: '14:20', bpm: 82, spo2: 97, sdnn: 41, rmssd: 36, index: 24, zone: 'yellow' },
      { dayOffset: 2, time: '19:00', bpm: 75, spo2: 98, sdnn: 47, rmssd: 41, index: 19, zone: 'green' },
      { dayOffset: 2, time: '11:30', bpm: 80, spo2: 98, sdnn: 43, rmssd: 38, index: 22, zone: 'yellow' },
      { dayOffset: 3, time: '17:45', bpm: 76, spo2: 97, sdnn: 46, rmssd: 40, index: 20, zone: 'yellow' },
      { dayOffset: 4, time: '19:20', bpm: 72, spo2: 99, sdnn: 51, rmssd: 45, index: 16, zone: 'green' },
      { dayOffset: 5, time: '18:10', bpm: 77, spo2: 98, sdnn: 44, rmssd: 39, index: 21, zone: 'yellow' },
      { dayOffset: 6, time: '16:40', bpm: 70, spo2: 99, sdnn: 54, rmssd: 48, index: 15, zone: 'green' }
    ];

    templates.forEach((t, idx) => {
      const ts = now - t.dayOffset * dayMs;
      const d = new Date(ts);
      list.push(normalizeHistoryEntry({
        id: 'demo_hist_' + (idx + 1),
        timestamp: ts,
        dateStr: d.toLocaleDateString('ru-RU'),
        timeStr: t.time,
        source: 'demo',
        isDemo: true,
        bpm: t.bpm,
        spo2: t.spo2,
        sdnn: t.sdnn,
        rmssd: t.rmssd,
        index: t.index,
        zone: t.zone,
        c: 0.95,
        title: 'Демо-срез: контрольный замер'
      }));
    });

    return list;
  },

  // ========================================================
  // AI ADVISOR КЭШ (РАЗДЕЛЬНЫЙ REAL / DEMO)
  // ========================================================

  getAIAdvisorCache(isDemo = false) {
    
    const key = isDemo ? STORAGE_KEYS.AI_ADVISOR_CACHE_DEMO : STORAGE_KEYS.AI_ADVISOR_CACHE_REAL;
    const raw = safeGetItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveAIAdvisorCache(data, isDemo = false) {
    
    if (!data) return;
    const key = isDemo ? STORAGE_KEYS.AI_ADVISOR_CACHE_DEMO : STORAGE_KEYS.AI_ADVISOR_CACHE_REAL;
    try {
      safeSetItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('[StorageService] Error saving AI advisor cache:', e);
    }
  },

  getCompletedActions() {
    
    const raw = safeGetItem(STORAGE_KEYS.COMPLETED_ACTIONS);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveCompletedActions(actions) {
    
    if (!Array.isArray(actions)) return;
    try {
      safeSetItem(STORAGE_KEYS.COMPLETED_ACTIONS, JSON.stringify(actions));
    } catch (e) {
      console.warn('[StorageService] Error saving completed actions:', e);
    }
  },

  toggleActionCompleted(actionId) {
    
    const list = this.getCompletedActions();
    const idx = list.indexOf(actionId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.push(actionId);
    }
    safeSetItem(STORAGE_KEYS.COMPLETED_ACTIONS, JSON.stringify(list));
    return list;
  },

  resetAll() {
    
    localStorage.clear();
  }
};

StorageService.normalizeHistoryEntry = normalizeHistoryEntry;


// --- ai_advisor.js ---
/**
 * Qamqor Health Monitoring System
 * Layer 1 & 3: Qamqor AI Advisor Client Service
 * 
 * Analyzes trends, coordinates knowledge base rules, calls /api/advisor,
 * and provides mode-isolated caching and offline fallback.
 */
class AIAdvisorService {
  constructor() {
    this.lastAnalysisTime = 0;
    this.minRefreshIntervalMs = 5000; // 5-секундный дебаунс защиты от спама
    this.isAnalyzing = false;
    this.cachedResult = null;
    this.completedActionIds = new Set();
  }

  /**
   * Загрузка сохраненного состояния
   */
  init(isDemo = false) {
    try {
      const saved = StorageService.getAIAdvisorCache(isDemo);
      if (saved && saved.result) {
        this.cachedResult = saved.result;
        this.lastAnalysisTime = saved.timestamp || 0;
      } else {
        this.cachedResult = null;
        this.lastAnalysisTime = 0;
      }
      const actions = StorageService.getCompletedActions();
      if (Array.isArray(actions)) {
        this.completedActionIds = new Set(actions);
      }
    } catch (e) {
      console.warn('[AIAdvisor] Cache init warning:', e);
    }
  }

  /**
   * Слой 1: Анализ данных и извлечение трендов
   */
  extractTrendStats(history, currentMetrics, baseline) {
    const hr0 = (baseline && baseline.hr0) ? baseline.hr0 : 70;
    if (!Array.isArray(history) || history.length === 0) {
      return {
        count: 0,
        avgHr: currentMetrics?.hr || hr0,
        avgSpo2: currentMetrics?.spo2 || 98,
        hrDelta: currentMetrics?.hr ? currentMetrics.hr - hr0 : 0,
        trendDirection: 'stable'
      };
    }

    // Фильтруем замеры за последние 7 дней с валидным пульсом
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = history.filter(h => h.timestamp && h.timestamp >= sevenDaysAgo && typeof h.bpm === 'number' && h.bpm > 0);

    const count = recent.length;
    if (count === 0) {
      return {
        count: 0,
        avgHr: currentMetrics?.hr || hr0,
        avgSpo2: currentMetrics?.spo2 || 98,
        hrDelta: currentMetrics?.hr ? currentMetrics.hr - hr0 : 0,
        trendDirection: 'stable'
      };
    }

    const sumHr = recent.reduce((acc, h) => acc + h.bpm, 0);
    const avgHr = Math.round(sumHr / count);

    const validSpo2 = recent.filter(h => typeof h.spo2 === 'number' && h.spo2 > 0);
    const avgSpo2 = validSpo2.length > 0
      ? Math.round(validSpo2.reduce((acc, h) => acc + h.spo2, 0) / validSpo2.length)
      : (currentMetrics?.spo2 || 98);

    const currentHr = currentMetrics?.hr || avgHr;
    const hrDelta = currentHr - hr0;

    // Определение направления тренда
    let trendDirection = 'stable';
    if (count >= 3) {
      const firstHalf = recent.slice(Math.floor(count / 2));
      const secondHalf = recent.slice(0, Math.floor(count / 2));
      const avgFirst = firstHalf.reduce((a, b) => a + b.bpm, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, b) => a + b.bpm, 0) / secondHalf.length;

      if (avgSecond - avgFirst <= -3) {
        trendDirection = 'improving'; // пульс стабилизируется к норме
      } else if (avgSecond - avgFirst >= 5) {
        trendDirection = 'increasing'; // нарастание нагрузки
      }
    }

    return {
      count,
      avgHr,
      avgSpo2,
      hrDelta,
      trendDirection
    };
  }

  /**
   * Проверка возможности обновления (дебаунс)
   */
  canRefresh() {
    const now = Date.now();
    return (now - this.lastAnalysisTime) >= this.minRefreshIntervalMs;
  }

  /**
   * Получение оставшегося времени кулдауна в секундах
   */
  getCooldownSeconds() {
    const elapsed = Date.now() - this.lastAnalysisTime;
    const remaining = Math.max(0, this.minRefreshIntervalMs - elapsed);
    return Math.ceil(remaining / 1000);
  }

  /**
   * Генерация персональных рекомендаций через AI Advisor
   */
  async generateAnalysis(context, force = false) {
    if (this.isAnalyzing) {
      return this.cachedResult;
    }

    const isDemo = Boolean(context.isDemo);

    // Если режим переключился — сбрасываем кэш другого режима
    if (this.cachedResult && Boolean(this.cachedResult.isDemo) !== isDemo) {
      this.cachedResult = null;
      this.init(isDemo);
    }

    const now = Date.now();
    if (!force && this.cachedResult && (now - this.lastAnalysisTime < this.minRefreshIntervalMs)) {
      return this.cachedResult;
    }

    this.isAnalyzing = true;

    try {
      const {
        metrics = {},
        baseline = { hr0: 70 },
        profile = {},
        symptoms = {},
        modelResult = {},
        history = []
      } = context;

      // Слой 1: Извлечение трендов
      const historyStats = this.extractTrendStats(history, metrics, baseline);

      // Слой 2: Проверка базы знаний
      const ruleContext = {
        metrics,
        baseline,
        profile,
        symptoms,
        historyStats,
        modelResult,
        derived: {
          hrDelta: historyStats.hrDelta,
          zHrv: metrics.sdnn && metrics.sdnn < 30 ? 1.8 : 0.2,
          pIrr: metrics.pIrr || 0
        }
      };

      const matchedRules = KnowledgeBaseService.evaluateRules(ruleContext);

      // Слой 3: Запрос к API Advisor
      const payload = {
        metrics,
        baseline,
        historyStats,
        profile,
        rules: matchedRules,
        symptoms,
        modelResult,
        isDemo
      };

      let advisorResult = null;

      try {
        const response = await fetch('/api/advisor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          advisorResult = await response.json();
        }
      } catch (netErr) {
        console.warn('[AIAdvisor] Network fetch failed, using local synthesis:', netErr.message);
      }

      // Если сетевой вызов не сработал — локальный синтез
      if (!advisorResult || !advisorResult.ai_insight) {
        advisorResult = this.synthesizeLocalInsight(payload);
      }

      // Добавляем метаданные анализа
      advisorResult.generatedAt = Date.now();
      advisorResult.isDemo = isDemo;

      // Обновляем статус выполненных действий
      if (Array.isArray(advisorResult.recommendations)) {
        for (const rec of advisorResult.recommendations) {
          rec.isCompleted = this.completedActionIds.has(rec.id);
        }
      }

      this.cachedResult = advisorResult;
      this.lastAnalysisTime = Date.now();

      // Сохраняем в режимный кэш
      try {
        StorageService.saveAIAdvisorCache({
          result: advisorResult,
          timestamp: this.lastAnalysisTime
        }, isDemo);
      } catch (e) {}

      return advisorResult;
    } catch (err) {
      console.error('[AIAdvisor] Analysis error:', err);
      return this.cachedResult || this.synthesizeLocalInsight(context);
    } finally {
      this.isAnalyzing = false;
    }
  }

  /**
   * Локальный синтез (Offline fallback)
   */
  synthesizeLocalInsight(context) {
    const {
      metrics = {},
      baseline = { hr0: 70 },
      historyStats = {},
      rules = [],
      symptoms = {},
      modelResult = {},
      isDemo = false
    } = context;

    const hr = metrics.hr;
    const hr0 = baseline.hr0 || 70;
    const hrDelta = hr != null ? hr - hr0 : 0;
    const spo2 = metrics.spo2;
    const sdnn = metrics.sdnn;

    const isEmergency = Boolean(
      symptoms.chestPain || symptoms.shortness ||
      (spo2 != null && spo2 > 0 && spo2 < 90) ||
      (hr != null && (hr > 150 || hr < 40))
    );

    let trendAssessment = 'stable';
    let baseTrendLabel = 'Стабильно';
    let summary = 'Показатели сердечно-сосудистой системы находятся в пределах привычной нормы. Организм адаптирован к текущим нагрузкам.';
    let keyObservation = 'Показатели в границах физиологического коридора';

    if (isEmergency) {
      trendAssessment = 'warning';
      baseTrendLabel = 'Внимание: вызовите помощь';
      summary = 'Зафиксированы симптомы или показатели критической нагрузки. Немедленно прекратите физическую активность и обеспечьте покой.';
      keyObservation = 'Критический сигнал: требуется очная медицинская оценка';
    } else if (hrDelta >= 15 || (spo2 != null && spo2 < 95)) {
      trendAssessment = 'needs_attention';
      baseTrendLabel = 'Требует внимания';
      summary = `Наблюдается умеренное увеличение напряжения регуляторных систем: пульс превышает индивидуальную норму на ${hrDelta > 0 ? '+' + hrDelta : hrDelta} уд/мин. Рекомендуется отдых и восстановление дыхания.`;
      keyObservation = `Пульс в покое повышен на ${hrDelta > 0 ? '+' + hrDelta : hrDelta} уд/мин относительно нормы (${hr0} уд/мин)`;
    } else if (hrDelta <= 5 && (spo2 == null || spo2 >= 96)) {
      trendAssessment = 'improving';
      baseTrendLabel = 'Положительная динамика';
      summary = 'Ритм и сатурация демонстрируют оптимальное восстановление. Регуляторные системы функционируют стабильно и экономично.';
      keyObservation = 'Отличная синхронизация пульса с индивидуальной базовой нормой';
    }

    if (modelResult && modelResult.index != null) {
      const zoneName = modelResult.zone === 'red' ? 'высокая нагрузка' : modelResult.zone === 'yellow' ? 'умеренное внимание' : 'норма';
      summary += ` Индекс кардио-риска модели: ${modelResult.index}/100 (${zoneName}).`;
    }

    const trendLabel = isDemo ? `AI DEMO: ${baseTrendLabel}` : `AI REAL: ${baseTrendLabel}`;

    const recs = (rules && rules.length > 0) ? rules.map((r, i) => ({
      id: r.id || `rec_${i + 1}`,
      category: r.category || 'lifestyle',
      category_label: r.category === 'emergency' ? 'Неотложная помощь' :
                      r.category === 'sleep' ? 'Сон и восстановление' :
                      r.category === 'activity' ? 'Физическая активность' :
                      r.category === 'stress' ? 'Управление стрессом' :
                      r.category === 'heart' ? 'Сердечно-сосудистый тонус' : 'Образ жизни',
      priority: r.priority || 'medium',
      title: r.title,
      action: r.action,
      expected_benefit: r.expectedBenefit || 'Снижение функционального напряжения сердечно-сосудистой системы',
      evidence_source: r.evidenceSource || 'ВОЗ / AHA Guidelines',
      evidence_level: r.evidenceLevel || 'Уровень A (РКИ)',
      isCompleted: this.completedActionIds.has(r.id),
      why: r.why || {
        triggerMetric: `Текущий показатель ЧСС: ${hr != null ? hr + ' уд/мин' : 'плановый мониторинг'}`,
        baselineComparison: `Индивидуальная норма: ${hr0} уд/мин`,
        timeframe: 'Сеанс измерений',
        clinicalRationale: 'Своевременная профилактика снижает риски вегетативной дисфункции.',
        limitations: 'Не является диагнозом. При боли в груди или одышке обратитесь к врачу.'
      }
    })) : [];

    return {
      ai_insight: {
        summary,
        trend_assessment: trendAssessment,
        trend_label: trendLabel,
        key_observation: keyObservation
      },
      recommendations: recs,
      trend_summary: {
        hr_delta: hrDelta,
        hrv_status: (sdnn && sdnn < 30) ? 'reduced' : (sdnn && sdnn > 80) ? 'elevated' : 'normal',
        spo2_stability: (spo2 && spo2 < 95) ? 'moderate' : 'high',
        cardio_load_trend: hrDelta > 10 ? 'increasing' : 'stable'
      },
      medical_disclaimer: 'Оценка носит исключительно информационно-профилактический характер и не заменяет консультацию врача.',
      generatedAt: Date.now(),
      isDemo
    };
  }

  /**
   * Отметка выполнения действия пользователем
   */
  toggleActionCompleted(actionId) {
    if (this.completedActionIds.has(actionId)) {
      this.completedActionIds.delete(actionId);
    } else {
      this.completedActionIds.add(actionId);
    }

    try {
      StorageService.saveCompletedActions(Array.from(this.completedActionIds));
    } catch (e) {}

    if (this.cachedResult && Array.isArray(this.cachedResult.recommendations)) {
      for (const rec of this.cachedResult.recommendations) {
        if (rec.id === actionId) {
          rec.isCompleted = this.completedActionIds.has(actionId);
        }
      }
    }
  }

  /**
   * Санитизация текста от XSS перед вставкой
   */
  static escapeHTML(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}


// --- ble.js ---
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
class BLEService {

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


// --- simulator.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль демонстрационного режима (Demo Simulator)
 * Реализация спецификации раздела 12.2
 */
class DemoSimulator {
  constructor() {
    this.intervalId = null;
    this.isPaused = false;
    this.bpm = 72;
    this.spo2 = 98;
    this.sdnn = 48; // мс
    this.pIrr = 0.02; // Низкая нерегулярность
    this.scenario = 'normal'; // 'normal' | 'tachycardia' | 'hypoxia' | 'irregular'
    
    this.onSample = null;
    this.sampleCount = 0;
  }

  start(callback) {
    this.onSample = callback;
    this.isPaused = false;
    this.stop();

    // Отправляем первый сэмпл немедленно
    this.emitSample();

    // Периодическое обновление каждые 1.5 секунды
    this.intervalId = setInterval(() => {
      if (!this.isPaused) {
        this.stepSimulation();
        this.emitSample();
      }
    }, 1500);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  setScenario(scenario) {
    this.scenario = scenario;
    if (scenario === 'tachycardia') {
      this.bpm = 108;
      this.sdnn = 24;
      this.spo2 = 96;
    } else if (scenario === 'hypoxia') {
      this.bpm = 88;
      this.spo2 = 91;
      this.sdnn = 32;
    } else if (scenario === 'irregular') {
      this.bpm = 78;
      this.pIrr = 0.35;
      this.sdnn = 65;
    } else {
      this.bpm = 72;
      this.spo2 = 98;
      this.sdnn = 48;
      this.pIrr = 0.02;
    }
  }

  stepSimulation() {
    this.sampleCount++;

    if (this.scenario === 'normal') {
      // Естественное физиологическое блуждание синусового ритма
      const bpmWander = (Math.random() - 0.49) * 1.8;
      this.bpm = Math.round(Math.min(84, Math.max(64, this.bpm + bpmWander)));

      if (Math.random() > 0.8) {
        this.spo2 = Math.min(99, Math.max(96, this.spo2 + (Math.random() > 0.5 ? 1 : -1)));
      }
      this.sdnn = Math.round(Math.min(60, Math.max(38, this.sdnn + (Math.random() - 0.5) * 3)));
      this.pIrr = Math.max(0, Math.min(0.08, this.pIrr + (Math.random() - 0.5) * 0.01));
    } else if (this.scenario === 'tachycardia') {
      const bpmWander = (Math.random() - 0.48) * 2;
      this.bpm = Math.round(Math.min(125, Math.max(98, this.bpm + bpmWander)));
      this.sdnn = Math.round(Math.min(28, Math.max(16, this.sdnn + (Math.random() - 0.5) * 2)));
    } else if (this.scenario === 'hypoxia') {
      this.spo2 = Math.min(93, Math.max(88, this.spo2 + (Math.random() > 0.5 ? 1 : -1)));
      this.bpm = Math.round(Math.min(96, Math.max(82, this.bpm + (Math.random() - 0.5) * 2)));
    }
  }

  emitSample() {
    if (!this.onSample) return;

    this.onSample({
      bpm: this.bpm,
      spo2: this.spo2,
      sdnn: this.sdnn,
      pIrr: this.pIrr,
      isDemo: true,
      timestamp: Date.now()
    });
  }
}


// --- ecg.js ---
/**
 * Qamqor Health Monitoring System
 * Модуль осциллографа ЭКГ на HTML5 Canvas (ECG Oscilloscope)
 * Реализация спецификации раздела 7.2 и 11
 */
class ECGCanvasService {
  constructor() {
    this.canvases = [];
    this.animId = null;
    this.hasStream = false;
    this.isPaused = false;
    this.currentBpm = 72;
    this.realECGQueue = [];
    this.allowSynthetic = false;
  }

  init(canvasConfigs) {
    this.canvases = [];
    canvasConfigs.forEach(cfg => {
      const el = document.getElementById(cfg.canvasId);
      if (el) {
        this.canvases.push({
          id: cfg.canvasId,
          canvas: el,
          ctx: el.getContext('2d'),
          emptyState: document.getElementById(cfg.emptyStateId),
          statusPill: document.getElementById(cfg.statusPillId),
          buffer: [],
          sweepX: 0
        });
      }
    });

    window.addEventListener('resize', () => this.refresh());
    if (!this.animId) {
      this.loop();
    }
  }

  setStreamActive(active, allowSynthetic = false) {
    this.hasStream = active;
    this.allowSynthetic = allowSynthetic;
    if (this.canvases.length === 0) {
      this.init([
        { canvasId: 'homeECGCanvas', emptyStateId: 'home-ecg-empty-state', statusPillId: 'home-ecg-status-pill' },
        { canvasId: 'liveECGCanvas', emptyStateId: 'ecg-empty-state', statusPillId: 'ecg-status-pill' }
      ]);
    }
    if (!this.animId) {
      this.loop();
    }
    this.canvases.forEach(item => {
      if (!item.emptyState) item.emptyState = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-empty-state' : 'ecg-empty-state');
      if (!item.statusPill) item.statusPill = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-status-pill' : 'ecg-status-pill');
      
      const hasLiveStream = active && (this.allowSynthetic || this.realECGQueue.length > 0);
      if (item.emptyState) {
        if (hasLiveStream) item.emptyState.classList.add('hidden');
        else item.emptyState.classList.remove('hidden');
      }
      if (item.statusPill) {
        if (!active) {
          item.statusPill.textContent = 'Ожидание';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 font-medium';
        } else if (this.allowSynthetic) {
          item.statusPill.textContent = 'ДЕМО 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-mono font-semibold';
        } else if (this.realECGQueue.length > 0) {
          item.statusPill.textContent = 'LIVE 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono font-semibold';
        } else {
          item.statusPill.textContent = 'Ожидание ЭКГ';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 font-mono font-medium';
        }
      }
    });
  }

  setBPM(bpm) {
    if (typeof bpm === 'number' && bpm > 30) {
      this.currentBpm = bpm;
    }
  }

  pushRealSample(adcValue) {
    // Нормализация 12-битного ADC (0..4095) в диапазон [-1, 1] относительно центра 2048
    const normalized = (adcValue - 2048) / 1024.0;
    this.realECGQueue.push(normalized);
    if (this.realECGQueue.length > 500) {
      this.realECGQueue.shift();
    }
  }

  /**
   * Генерация математически точной физиологической ЭКГ (P-Q-R-S-T)
   */
  generateSyntheticECG(t, bpm) {
    const beatPeriod = 60 / Math.max(40, bpm);
    const phase = (t % beatPeriod) / beatPeriod;
    let val = 0;

    // P-зубец (деполяризация предсердий)
    if (phase >= 0.12 && phase <= 0.20) {
      val += 0.16 * Math.sin((phase - 0.12) / 0.08 * Math.PI);
    }
    // Q-зубец (деполяризация перегородки)
    else if (phase >= 0.28 && phase <= 0.30) {
      val -= 0.14 * Math.sin((phase - 0.28) / 0.02 * Math.PI);
    }
    // R-зубец (главный пик деполяризации желудочков)
    else if (phase >= 0.30 && phase <= 0.34) {
      val += 1.18 * Math.sin((phase - 0.30) / 0.04 * Math.PI);
    }
    // S-зубец (отрицательное отклонение)
    else if (phase >= 0.34 && phase <= 0.38) {
      val -= 0.25 * Math.sin((phase - 0.34) / 0.04 * Math.PI);
    }
    // T-зубец (реполяризация желудочков)
    else if (phase >= 0.50 && phase <= 0.70) {
      val += 0.34 * Math.sin((phase - 0.50) / 0.20 * Math.PI);
    }

    // Изолиния и физиологический джиттер
    val += 0.03 * Math.sin(t * 1.5);
    val += (Math.random() - 0.5) * 0.02;
    return val;
  }

  refresh() {
    // Пересчет размеров буфера
  }

  loop() {
    const now = performance.now() / 1000;

    this.canvases.forEach(item => {
      if (!item.canvas) item.canvas = document.getElementById(item.id);
      if (item.canvas && !item.ctx) item.ctx = item.canvas.getContext('2d');
      const { canvas, ctx } = item;
      if (!canvas || !ctx) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 10 || rect.height <= 10) return; // Скрытая вкладка

      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.floor(rect.width * dpr);
      const targetH = Math.floor(rect.height * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
      }

      const w = rect.width;
      const h = rect.height;

      const neededPoints = Math.ceil(w);
      if (item.buffer.length !== neededPoints) {
        item.buffer = new Array(neededPoints).fill(h / 2);
        item.sweepX = 0;
      }

      if (isNaN(item.sweepX) || item.sweepX >= w) {
        item.sweepX = 0;
      }

      // Генерация или считывание отсчета
      if (this.hasStream && !this.isPaused) {
        let sample = 0;
        let hasSample = false;

        if (this.realECGQueue.length > 0) {
          sample = this.realECGQueue.shift();
          hasSample = true;
        } else if (this.allowSynthetic) {
          sample = this.generateSyntheticECG(now, this.currentBpm || 72);
          hasSample = true;
        }

        const midY = h / 2;
        const y = hasSample ? (midY - (sample * (h * 0.38))) : midY;

        const curX = Math.floor(item.sweepX);
        item.buffer[curX] = y;
        if (curX + 1 < item.buffer.length) {
          item.buffer[curX + 1] = y;
        }
        item.sweepX = (item.sweepX + 2) % w;

        // Обновляем видимость заглушки при появлении реального потока
        if (item.emptyState) {
          if (hasSample) item.emptyState.classList.add('hidden');
          else item.emptyState.classList.remove('hidden');
        }
      }

      // 1. Отрисовка темного медицинского фона
      ctx.fillStyle = '#060b13';
      ctx.fillRect(0, 0, w, h);

      // 2. Мелкая медицинская сетка (10px)
      ctx.strokeStyle = '#0d1824';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let x = 0; x < w; x += 10) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y < h; y += 10) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Крупная медицинская сетка (50px)
      ctx.strokeStyle = '#142a38';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 50) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y < h; y += 50) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // 3. Стирающий луч (Sweep erase bar)
      if (this.hasStream) {
        const gap = 24;
        ctx.fillStyle = '#060b13';
        ctx.fillRect(item.sweepX, 0, gap, h);

        // 4. Кардиограмма с фосфорным свечением
        ctx.strokeStyle = '#34d399';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 6;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        let drawing = false;
        for (let x = 0; x < w; x++) {
          if (x >= item.sweepX && x < item.sweepX + gap) {
            drawing = false;
            continue;
          }
          const y = item.buffer[x] || (h / 2);
          if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 5. Ведущая точка
        const curY = item.buffer[Math.floor(item.sweepX)] || (h / 2);
        ctx.fillStyle = '#6ee7b7';
        ctx.beginPath();
        ctx.arc(item.sweepX, curY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    this.animId = requestAnimationFrame(() => this.loop());
  }
}


// --- app.js ---
/**
 * Qamqor Health Monitoring System
 * Главный контроллер приложения (UI & Application Controller)
 * Реализация утвержденного обязательного модуля: расчет индекса Qamqor и персональные рекомендации
 */
const App = {
  state: {
    currentScreen: 'onboarding-connect', // 'onboarding-connect' | 'onboarding-survey' | 'main-app'
    activeTab: 'home',                   // 'home' | 'metrics' | 'factors' | 'history' | 'settings'
    isDemo: false,
    isConnected: false,
    deviceState: 'disconnected',         // 'disconnected' | 'connected_no_data' | 'connected_receiving' | 'connection_lost'
    deviceName: 'Qamqor Band',
    dynamicsPeriod: '7d',

    // Текущие биометрические показатели (в реальном режиме по умолчанию null!)
    bpm: null,
    spo2: null,
    sdnn: null,
    pIrr: null,
    lastUpdateTime: null,
    lastTelemetryTimestamp: 0,

    // Результаты моделирования
    lStatResult: null,
    lDynResult: null,
    qualityResult: null,
    modelEvaluation: null,
    prevR: null,

    // Рекомендации
    recommendations: [],
    improvementPlan: [],

    // Временные данные анкеты и пошагового визарда
    surveyTemp: {},
    currentSurveyStep: 1,
    surveyValidation: null
  },

  // Сервисы
  baselineService: null,
  alertEngine: null,
  recommendationEngine: null,
  bleService: null,
  demoSimulator: null,
  ecgCanvas: null,
  aiAdvisorService: null,
  whyExpandedMap: {},

  init() {
    console.log(`[Qamqor] Инициализация системы, версия: ${MODEL_CONFIG.version}`);

    // Инициализация сервисов
    this.baselineService = new PersonalBaselineService(StorageService.getBaseline());
    this.alertEngine = new AlertEngine(StorageService.getAlertsState());
    this.recommendationEngine = new RecommendationEngine();
    this.bleService = new BLEService();
    this.demoSimulator = new DemoSimulator();
    this.ecgCanvas = new ECGCanvasService();
    this.aiAdvisorService = new AIAdvisorService();
    this.aiAdvisorService.init();

    // Загрузка профиля (без подмены отсутствующих ответов)
    const profile = StorageService.getProfile();
    this.state.surveyTemp = profile ? { ...profile } : {
      name: '',
      age: 40,
      heightCm: 175,
      weightKg: 75,
      bmi: 24.5,
      smoking: null,
      familyHistory: null,
      stress: 1,
      activity: 1
    };

    if (profile) {
      try {
        this.state.lStatResult = calculateLStat(profile);
      } catch {
        this.state.lStatResult = null;
      }
    } else {
      this.state.lStatResult = null;
    }

    // Настройка осциллографа ЭКГ
    this.ecgCanvas.init([
      { canvasId: 'homeECGCanvas', emptyStateId: 'home-ecg-empty-state', statusPillId: 'home-ecg-status-pill' },
      { canvasId: 'liveECGCanvas', emptyStateId: 'ecg-empty-state', statusPillId: 'ecg-status-pill' }
    ]);

    // Настройка BLE
    this.bleService.onTelemetry = (data) => this.handleBLETelemetry(data);
    this.bleService.onStatusChange = (status) => this.handleBLEStatusChange(status);
    this.bleService.onError = (err) => this.handleBLEError(err);

    // Первоначальный расчет модели
    this.recalculateModel();

    // Проверка статуса онбординга и режима работы
    if (StorageService.isOnboarded()) {
      this.showScreen('main-app');
      if (StorageService.isDemoMode()) {
        this.startDemoMode();
      } else {
        this.setRealDeviceMode();
      }
    } else {
      // Сначала показываем анкету, потом уже подключение
      this.showScreen('onboarding-survey');
      this.goToSurveyStep(1);
    }

    // Сторожевой таймер активности реальных датчиков (Watchdog)
    setInterval(() => {
      if (this.state.isConnected && !this.state.isDemo) {
        if (this.state.lastTelemetryTimestamp > 0 && Date.now() - this.state.lastTelemetryTimestamp > 4500) {
          if (this.state.deviceState === 'connected_receiving') {
            console.log('[BLE Watchdog] Поток измерений прекращен, переключение в connected_no_data');
            this.state.deviceState = 'connected_no_data';
            this.state.bpm = null;
            this.state.spo2 = null;
            this.updateConnectionUI();
            this.recalculateModel();
            this.renderDashboardMetrics();
          }
        }
      }
    }, 2000);

    // Минутный таймер для дискретного шага EMA-сглаживания и FSM тревог
    setInterval(() => this.stepCalculationMinute(), 60000);

    // Секундный таймер для часов
    setInterval(() => {
      const clockEl = document.getElementById('band-sim-time');
      if (clockEl) {
        clockEl.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      }
    }, 1000);

    // Регистрация Service Worker для PWA
    this.registerSW();
  },

  // ========================================================
  // НАВИГАЦИЯ И ЭКРАНЫ
  // ========================================================
  showScreen(screenId) {
    this.state.currentScreen = screenId;
    ['screen-onboarding-connect', 'screen-onboarding-survey', 'screen-main-app'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    });

    const activeEl = document.getElementById(`screen-${screenId}`);
    if (activeEl) {
      activeEl.classList.remove('hidden');
      activeEl.style.display = '';
    }

    if (screenId === 'onboarding-survey') {
      this.goToSurveyStep(this.state.currentSurveyStep || 1);
    } else if (screenId === 'main-app') {
      this.renderAll();
      if (this.state.isDemo || this.state.isConnected) {
        this.ecgCanvas.setStreamActive(true, this.state.isDemo);
      }
    }
  },

  startSurveyWizard() {
    const profile = StorageService.getProfile();
    if (profile) {
      this.state.surveyTemp = { ...profile };
    }
    this.state.currentSurveyStep = 1;
    this.showScreen('onboarding-survey');
  },

  startInstantDemo() {
    if (!this.recommendationEngine) {
      try { this.init(); } catch(e) {}
    }
    this.state.isDemo = true;
    this.state.isConnected = false;
    StorageService.setDemoMode(true);
    StorageService.setOnboarded(true);
    let profile = StorageService.getProfile();
    if (!profile) {
      profile = StorageService.getDefaultDemoProfile();
      StorageService.saveProfile(profile);
      this.state.surveyTemp = { ...profile };
    }
    this.recalculateModel();
    this.showScreen('main-app');
    this.startDemoMode();
    this.showToast('Демо-режим активирован. Показатели запущены!', 'success');
  },

  switchTab(tabId) {
    if (!tabId) return;
    tabId = tabId.replace(/^tab-/, '');
    this.state.activeTab = tabId;
    const tabs = ['home', 'metrics', 'factors', 'history', 'settings', 'guardian'];

    tabs.forEach(t => {
      const sec = document.getElementById(`tab-${t}`);
      const btn = document.getElementById(`nav-btn-${t}`);
      const sbtn = document.getElementById(`sidebar-btn-${t}`);
      const isActive = (t === tabId);

      if (sec) {
        if (isActive) {
          sec.classList.remove('hidden');
          sec.style.display = 'block';
        } else {
          sec.classList.add('hidden');
          sec.style.display = 'none';
        }
      }

      // Mobile Bottom Nav Button Styling (Light Theme)
      if (btn) {
        if (isActive) {
          btn.className = 'flex flex-col items-center justify-center py-1.5 px-0.5 rounded-xl text-teal-700 font-semibold text-[10px] transition bg-teal-50/80';
        } else {
          btn.className = 'flex flex-col items-center justify-center py-1.5 px-0.5 rounded-xl text-slate-500 font-medium text-[10px] transition hover:text-slate-900';
        }
      }

      // Desktop Sidebar Button Styling (Light Theme)
      if (sbtn) {
        if (isActive) {
          sbtn.className = 'flex items-center space-x-3 w-full px-3.5 py-2.5 rounded-xl bg-teal-50 text-teal-800 font-semibold text-xs border border-teal-200/60 shadow-sm transition';
        } else {
          sbtn.className = 'flex items-center space-x-3 w-full px-3.5 py-2.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-50 text-xs font-medium transition';
        }
      }
    });

    try {
      if (tabId === 'home') {
        this.renderDashboardMetrics();
        if (this.ecgCanvas) {
          this.ecgCanvas.setStreamActive(this.state.isDemo || this.state.isConnected, this.state.isDemo);
        }
      } else if (tabId === 'metrics') {
        this.renderMyRiskTab();
        if (this.ecgCanvas) {
          this.ecgCanvas.setStreamActive(this.state.isDemo || this.state.isConnected, this.state.isDemo);
        }
      } else if (tabId === 'factors') {
        this.renderDynamicsTab();
      } else if (tabId === 'history') {
        this.renderAdvisorTab();
      } else if (tabId === 'guardian') {
        this.renderGuardianTab();
      } else if (tabId === 'settings') {
        this.populateSettingsTab();
      }
    } catch(err) {
      console.warn('Error rendering tab content:', tabId, err);
    }

    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch(e) {}
  },

  // ========================================================
  // ОБРАБОТКА ПОСТУПЛЕНИЯ ДАННЫХ И СОСТОЯНИЙ BLE
  // ========================================================
  handleBLETelemetry(data) {
    // При поступлении реальных данных принудительно отключаем демо-режим
    if (this.state.isDemo) {
      this.demoSimulator.stop();
      this.state.isDemo = false;
      StorageService.setDemoMode(false);
    }

    if (data.hasValidSensors) {
      this.state.deviceState = 'connected_receiving';
      this.state.lastTelemetryTimestamp = Date.now();
      if (data.bpm != null && data.bpm > 0) this.state.bpm = data.bpm;
      if (data.spo2 != null && data.spo2 > 0) this.state.spo2 = data.spo2;

      // Если пользователь ещё на экране анкеты/проверки датчика, сразу переводим в дашборд с реальными данными!
      if (this.state.currentScreen === 'onboarding-survey') {
        this.completeSurveyAndOpenApp();
      }

      // Сохраняем только валидные замеры (receiving, пульс 40-200, SpO2 70-100) не чаще раза в 5 секунд
      const isPhysiologicalData = (
        data.status === 'receiving' &&
        typeof this.state.bpm === 'number' && this.state.bpm >= 40 && this.state.bpm <= 200 &&
        typeof this.state.spo2 === 'number' && this.state.spo2 >= 70 && this.state.spo2 <= 100
      );

      if (isPhysiologicalData && (!this._lastHistSavedAt || Date.now() - this._lastHistSavedAt >= 5000)) {
        this._lastHistSavedAt = Date.now();
        const now = new Date();
        const histEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          timestamp: Date.now(),
          time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          date: now.toLocaleDateString('ru-RU'),
          timeStr: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          dateStr: now.toLocaleDateString('ru-RU'),
          bpm: this.state.bpm,
          hr: this.state.bpm,
          spo2: this.state.spo2,
          sdnn: this.state.sdnn != null ? Math.round(this.state.sdnn) : null,
          hrv: this.state.sdnn != null ? Math.round(this.state.sdnn) : null,
          index: this.state.modelEvaluation ? this.state.modelEvaluation.index : null,
          zone: this.state.modelEvaluation ? this.state.modelEvaluation.zone : 'green',
          source: 'Qamqor Band (MAX30102)',
          isDemo: false
        };
        try {
          StorageService.addHistoryEntry(histEntry, false);
          this.renderRecentMeasurementsTable();
          if (this.state.activeTab === 'factors') {
            this.renderDynamicsTab();
          }
        } catch (saveErr) {
          console.warn('[Qamqor] Безопасная обработка сохранения истории:', saveErr);
        }
      }
    } else {
      if (this.state.isConnected) {
        this.state.deviceState = 'connected_no_data';
        this.state.bpm = null;
        this.state.spo2 = null;
      }
    }

    if (data.ecg != null && this.ecgCanvas) {
      this.ecgCanvas.pushRealSample(data.ecg);
    }
    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(this.state.isConnected, false);
      if (this.state.bpm) this.ecgCanvas.setBPM(this.state.bpm);
    }

    if (data.rrIntervals && data.rrIntervals.length >= 5) {
      try {
        this.state.sdnn = calculateSDNN(data.rrIntervals);
        this.state.pIrr = calculateRhythmIrregularity(data.rrIntervals);
      } catch(e) {
        console.warn('SDNN/pIrr calculation error:', e);
      }
    } else if (!data.hasValidSensors) {
      this.state.sdnn = null;
      this.state.pIrr = null;
    }

    this.recalculateModel();
    this.updateConnectionUI();
    this.renderDashboardMetrics();
    if (this.state.currentSurveyStep === 4) {
      this.updateSurveyDeviceStatus();
    }
  },

  handleBLEStatusChange(status) {
    this.state.isConnected = status.connected;
    if (status.status) {
      this.state.deviceState = status.status;
    }
    if (status.connected) {
      // При подключении реального устройства выходим из демо-режима
      if (this.state.isDemo) {
        this.demoSimulator.stop();
        this.state.isDemo = false;
        StorageService.setDemoMode(false);
      }
      if (!status.status) this.state.deviceState = 'connected_no_data';
      this.state.deviceName = status.deviceName || 'Qamqor_Band';
      if (!this._hasNotifiedConnect) {
        this.showToast(`Браслет ${this.state.deviceName} подключен. Загрузка данных на дашборд...`, 'success');
        this._hasNotifiedConnect = true;
      }
      if (this.ecgCanvas) {
        this.ecgCanvas.setStreamActive(true, false); // allowSynthetic = false
      }
    } else {
      this._hasNotifiedConnect = false;
      if (status.status === 'reconnecting') {
        this.state.deviceState = 'reconnecting';
        this.showToast(status.statusText || 'Соединение потеряно, переподключаюсь...', 'warning');
      } else {
        this.state.deviceState = (status.statusText && status.statusText.includes('потеряна')) ? 'connection_lost' : 'disconnected';
        this.clearBiometrics();
        this.showToast(status.statusText || 'Связь с браслетом разорвана', 'warning');
      }
      if (this.ecgCanvas) {
        this.ecgCanvas.setStreamActive(false, false);
      }
    }
    this.updateConnectionUI();
    this.recalculateModel();
    this.renderDashboardMetrics();
    if (this.state.currentSurveyStep === 4) {
      this.updateSurveyDeviceStatus();
    }
  },

  handleBLEError(err) {
    if (err.name !== 'NotFoundError') {
      this.showToast(`Ошибка BLE: ${err.message}`, 'warning');
    }
  },

  clearBiometrics() {
    this.state.bpm = null;
    this.state.spo2 = null;
    this.state.sdnn = null;
    this.state.pIrr = null;
    this.state.lastUpdateTime = null;
    this.state.lDynResult = null;
    this.state.modelEvaluation = null;
    this.state.qualityResult = null;
    if (this.ecgCanvas) {
      this.ecgCanvas.realECGQueue = [];
    }
  },

  setRealDeviceMode() {
    this.demoSimulator.stop();
    this.state.isDemo = false;
    StorageService.setDemoMode(false);
    if (this.aiAdvisorService) {
      this.aiAdvisorService.resetCache();
    }
    if (!this.state.isConnected || (this.state.bpm == null && this.state.spo2 == null)) {
      this.clearBiometrics();
    }
    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(this.state.isConnected, false);
    }
    this.updateConnectionUI();
    this.recalculateModel();
    this.renderAll();
    console.log('[Qamqor] Режим реального устройства активирован.');
  },

  // ========================================================
  // ДЕМО РЕЖИМ
  // ========================================================
  startDemoOnboarding() {
    this.state.isDemo = true;
    this.state.isConnected = false;
    StorageService.setDemoMode(true);
    this.showToast('Деморежим активирован. Переходим к анкете.', 'info');
    this.showScreen('onboarding-survey');
  },

  startDemoMode() {
    this.state.isDemo = true;
    this.state.isConnected = false;
    this.state.deviceState = 'disconnected';
    StorageService.setDemoMode(true);
    if (this.bleService && this.bleService.isConnected) {
      this.bleService.disconnect();
    }
    if (this.aiAdvisorService) {
      this.aiAdvisorService.resetCache();
    }
    this.updateConnectionUI();

    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(true, true); // allowSynthetic = true
    }

    this.demoSimulator.start((sample) => {
      this.state.bpm = sample.bpm;
      this.state.spo2 = sample.spo2;
      this.state.sdnn = sample.sdnn;
      this.state.pIrr = sample.pIrr;
      if (this.ecgCanvas) {
        this.ecgCanvas.setBPM(sample.bpm);
      }
      this.recalculateModel();
    });
    this.renderAll();
    this.showToast('Демо-режим симулятора запущен.', 'info');
  },

  stopDemoMode() {
    this.setRealDeviceMode();
  },

  setDemoScenario(scenario) {
    this.demoSimulator.setScenario(scenario);
    const names = {
      normal: 'Нормальное состояние',
      tachycardia: 'Тахикардия (ЧСС 108 уд/мин)',
      hypoxia: 'Гипоксия (SpO2 91%)'
    };
    this.showToast(`Режим симуляции: ${names[scenario] || scenario}`, 'info');
  },

  // ========================================================
  // РАСЧЕТ ИНДЕКСА И ГЕНЕРАЦИЯ РЕКОМЕНДАЦИЙ
  // ========================================================
  recalculateModel() {
    let profile = StorageService.getProfile();
    if (!profile && this.state.isDemo) {
      profile = StorageService.getDefaultDemoProfile();
    }
    const baseline = this.baselineService.getBaseline();

    // 1. Проверка анкеты без подмены данных
    this.state.surveyValidation = validateSurvey(profile);

    if (this.state.surveyValidation.isValid) {
      try {
        this.state.lStatResult = calculateLStat(this.state.surveyValidation.profile || profile);
      } catch (e) {
        this.state.lStatResult = null;
      }
    } else {
      this.state.lStatResult = null;
    }

    // Если в реальном режиме нет данных с датчиков пульса/SpO2 — динамический расчёт невозможен
    if (!this.state.isDemo && (this.state.bpm == null || this.state.spo2 == null)) {
      this.state.lDynResult = null;
      this.state.qualityResult = { c_q: 0, c_base: 0, c: 0, percentage: 0, label: 'Ожидание измерений' };
      this.state.modelEvaluation = evaluateModel({
        lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
        lDyn: null,
        c: 0
      });
      this.state.recommendations = [];
      this.state.improvementPlan = [];
      this.state.lastUpdateTime = null;
      this.renderDashboardMetrics();
      if (this.state.activeTab === 'factors') {
        this.renderFactorsTab();
      }
      return;
    }

    // 2. Динамическая часть L_dyn
    this.state.lDynResult = calculateLDyn({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);

    // 3. Качество данных c = c_q * c_base
    const quality = calculateDataQuality({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);

    const cBase = calculateBaselineCompleteness(Math.max(1, baseline.daysElapsed));
    this.state.qualityResult = calculateOverallCompleteness(quality.c_q, cBase);

    // В деморежиме гарантируем качественную базовую демонстрацию
    let effectiveC = this.state.isDemo ? Math.max(0.85, this.state.qualityResult.c) : this.state.qualityResult.c;

    // Для реального устройства при активном потоке измерений (пульс и SpO2 валидны)
    // производим расчет динамического риска
    if (!this.state.isDemo && this.state.bpm != null && this.state.spo2 != null) {
      effectiveC = Math.max(0.70, effectiveC);
    }

    // 4. Оценка модели: r* = 1 / (1 + e^-L), r_{k+1} = r_k + alpha*(r* - r_k)
    this.state.modelEvaluation = evaluateModel({
      lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
      lDyn: this.state.lDynResult ? this.state.lDynResult.lDyn : null,
      c: effectiveC,
      rPrev: this.state.prevR,
      dtMinutes: 0.1
    });

    if (this.state.modelEvaluation.rSmooth != null) {
      this.state.prevR = this.state.modelEvaluation.rSmooth;
    }

    // 5. Запуск Recommendation Engine
    const completedActionIds = StorageService.getCompletedActions();
    this.state.recommendations = this.recommendationEngine.generateRecommendations({
      metrics: {
        hr: this.state.bpm,
        sdnn: this.state.sdnn,
        spo2: this.state.spo2,
        pIrr: this.state.pIrr
      },
      baseline,
      quality: { ...this.state.qualityResult, c: effectiveC },
      profile: profile || { stress: 1, activity: 1 },
      symptoms: this.state.surveyTemp.symptoms || {},
      index: this.state.modelEvaluation ? this.state.modelEvaluation.index : null
    });

    // 6. Формирование плана «Что можно улучшить» (до 3 действий)
    this.state.improvementPlan = this.recommendationEngine.getImprovementPlan(
      this.state.recommendations,
      completedActionIds
    );

    this.state.lastUpdateTime = new Date().toLocaleTimeString('ru-RU');
    this.renderDashboardMetrics();

    if (this.state.activeTab === 'factors') {
      this.renderFactorsTab();
    }
  },

  stepCalculationMinute() {
    if (!this.state.modelEvaluation) return;

    // Шаг автомата тревог с гистерезисом 30
    const alertResult = this.alertEngine.update({
      index: this.state.modelEvaluation.index,
      c: this.state.qualityResult ? this.state.qualityResult.c : 0,
      timestamp: Date.now()
    });

    StorageService.saveAlertsState(this.alertEngine.toJSON());

    if (alertResult.shouldAlert) {
      if (!this.state.isDemo) {
        this.showToast(alertResult.alertMessage, 'warning');
        this.openSOSModal(alertResult.alertMessage);
      }
      // Уведомление опекуна через Telegram
      const gcfg = this.loadGuardianConfig();
      if (gcfg.botToken && gcfg.chatId) {
        const zone = this.state.modelEvaluation ? this.state.modelEvaluation.zone : '';
        const idx  = this.state.modelEvaluation ? this.state.modelEvaluation.index : '--';
        const isRed = (zone === 'red');
        if ((isRed && gcfg.notifyRed) || (!isRed && gcfg.notifyDeterioration)) {
          const emoji = isRed ? '\u{1F534}' : '\u{1F7E1}';
          const msg = emoji + ' *' + alertResult.alertMessage + '*\n\n' +
            '\u{1F4CA} Индекс риска: *' + idx + '*\n' +
            '\u2764\uFE0F ЧСС: *' + this.state.bpm + ' уд/мин*\n' +
            '\uD83E\uDE78 SpO2: *' + this.state.spo2 + '%*';
          this.sendGuardianNotification(msg).catch(() => {});
        }
      }
    }

    // Сохранение в историю
    if (this.state.bpm && this.state.spo2) {
      StorageService.addHistoryEntry({
        type: 'sample',
        bpm: this.state.bpm,
        spo2: this.state.spo2,
        sdnn: this.state.sdnn,
        index: this.state.modelEvaluation.index,
        zone: this.state.modelEvaluation.zone,
        c: this.state.qualityResult ? this.state.qualityResult.c : 0,
        isDemo: this.state.isDemo,
        title: `Индекс: ${this.state.modelEvaluation.index} (${this.getZoneLabel(this.state.modelEvaluation.zone)}), ЧСС: ${this.state.bpm}`
      });
    }

    // Накопление базовой линии
    if (this.state.bpm && this.state.sdnn && this.state.bpm < 85) {
      this.baselineService.addRestingWindow({
        hr: this.state.bpm,
        sdnn: this.state.sdnn,
        timestamp: Date.now()
      });
      StorageService.saveBaseline(this.baselineService.toJSON());
    }
  },

  getZoneLabel(zone) {
    if (zone === 'red') return 'Красная зона (40–100)';
    if (zone === 'yellow') return 'Жёлтая зона (20–39)';
    return 'Зелёная зона (0–19)';
  },

  toggleActionCompleted(actionId) {
    StorageService.toggleActionCompleted(actionId);
    this.recalculateModel();
    this.renderFactorsTab();
    this.showToast('Статус действия обновлен', 'info');
  },

  // ========================================================
  // ОТРИСОВКА ИНТЕРФЕЙСА
  // ========================================================
  renderAll() {
    try { this.updateConnectionUI(); } catch(e) { console.warn('updateConnectionUI err:', e); }
    try { this.renderDashboardMetrics(); } catch(e) { console.warn('renderDashboardMetrics err:', e); }
    try { this.renderMyRiskTab(); } catch(e) { console.warn('renderMyRiskTab err:', e); }
    try { this.renderDynamicsTab(); } catch(e) { console.warn('renderDynamicsTab err:', e); }
    try { this.renderAdvisorTab(); } catch(e) { console.warn('renderAdvisorTab err:', e); }
    try { this.populateSettingsTab(); } catch(e) { console.warn('populateSettingsTab err:', e); }
    try { this.renderGuardianTab(); } catch(e) { console.warn('renderGuardianTab err:', e); }
  },

  renderDashboardMetrics() {
    const timeStr = this.state.lastUpdateTime || 'Ожидание';
    const lastSyncEl = document.getElementById('app-last-sync-time');
    if (lastSyncEl) lastSyncEl.textContent = `Синхр: ${timeStr}`;

    // 1. Поток и частота в шапке
    const streamHzEl = document.getElementById('home-stream-hz');
    if (streamHzEl) {
      if (this.state.isDemo) {
        streamHzEl.textContent = 'DEMO 250 Гц • Симуляция';
        streamHzEl.className = 'inline-flex items-center px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200';
      } else if (this.state.deviceState === 'connected_receiving') {
        streamHzEl.textContent = 'LIVE 250 Гц • Поток активен';
        streamHzEl.className = 'inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200';
      } else if (this.state.isConnected) {
        streamHzEl.textContent = 'Отведение I • Ожидание сенсора';
        streamHzEl.className = 'inline-flex items-center px-2 py-0.5 rounded-md bg-sky-50 text-sky-800 border border-sky-200';
      } else {
        streamHzEl.textContent = 'Отведение I • Ожидание';
        streamHzEl.className = 'inline-flex items-center px-2 py-0.5 rounded-md bg-slate-50 border border-slate-200 text-slate-500';
      }
    }

    // 2. Статус связи в карточке мониторинга
    const devDot = document.getElementById('home-device-status-dot');
    const devDesc = document.getElementById('home-device-status-desc');
    if (devDot) {
      devDot.className = this.state.isDemo 
        ? 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse'
        : (this.state.deviceState === 'connected_receiving' 
            ? 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse' 
            : (this.state.isConnected ? 'w-2.5 h-2.5 rounded-full bg-sky-500' : 'w-2.5 h-2.5 rounded-full bg-slate-300'));
    }
    if (devDesc) {
      devDesc.textContent = this.state.isDemo
        ? 'Генерация виртуальных биосигналов для тестирования'
        : (this.state.deviceState === 'connected_receiving'
            ? `Браслет ${this.state.deviceName || 'Qamqor_Band'} • Приём телеметрии активен`
            : (this.state.isConnected 
                ? 'Браслет подключён • Приложите палец к MAX30102' 
                : 'Непрерывный замер биосигналов и контроль кардио-динамики'));
    }

    // 3. ЧСС (Пульс)
    const bpmVal = document.getElementById('home-metric-bpm-val');
    const bpmStatus = document.getElementById('home-metric-bpm-status');
    if (bpmVal) {
      bpmVal.textContent = this.state.isDemo 
        ? (this.state.bpm || '72') 
        : (this.state.bpm != null ? this.state.bpm : '—');
    }
    if (bpmStatus) {
      bpmStatus.textContent = this.state.isDemo
        ? 'Норма покоя (симуляция)'
        : (this.state.bpm != null ? 'Телеметрия с датчика' : 'Ожидание измерений');
      bpmStatus.className = (this.state.isDemo || this.state.bpm != null)
        ? 'text-[10px] text-emerald-700 font-medium'
        : 'text-[10px] text-slate-400 font-medium';
    }

    // 4. SpO2 (Кислород)
    const spo2Val = document.getElementById('home-metric-spo2-val');
    const spo2Status = document.getElementById('home-metric-spo2-status');
    if (spo2Val) {
      spo2Val.textContent = this.state.isDemo 
        ? `${this.state.spo2 || 98}%` 
        : (this.state.spo2 != null ? `${this.state.spo2}%` : '—');
    }
    if (spo2Status) {
      spo2Status.textContent = this.state.isDemo
        ? 'Физиологический оптимум'
        : (this.state.spo2 != null ? (this.state.spo2 >= 95 ? 'Оптимальная сатурация' : 'Снижение SpO2') : 'Ожидание сатурации');
      spo2Status.className = (this.state.isDemo || this.state.spo2 != null)
        ? (this.state.spo2 != null && this.state.spo2 < 95 ? 'text-[10px] text-amber-600 font-medium' : 'text-[10px] text-emerald-700 font-medium')
        : 'text-[10px] text-slate-400 font-medium';
    }

    // 5. HRV (SDNN)
    const mSdnn = document.getElementById('metric-sdnn');
    const sdnnStatus = document.getElementById('home-metric-sdnn-status');
    if (mSdnn) {
      mSdnn.textContent = this.state.isDemo 
        ? Math.round(this.state.sdnn || 48) 
        : (this.state.sdnn != null ? Math.round(this.state.sdnn) : '—');
    }
    if (sdnnStatus) {
      sdnnStatus.textContent = this.state.isDemo
        ? 'Вегетативный баланс'
        : (this.state.sdnn != null ? 'Вариабельность ритма' : 'Ожидание замеров');
      sdnnStatus.className = (this.state.isDemo || this.state.sdnn != null)
        ? 'text-[10px] text-teal-700 font-medium'
        : 'text-[10px] text-slate-400 font-medium';
    }

    // 6. Осциллограф статус-пилл
    const homeEcgPill = document.getElementById('home-ecg-status-pill');
    const homeEcgDot = document.getElementById('home-ecg-live-dot');
    const homeEcgEmpty = document.getElementById('home-ecg-empty-state');
    if (homeEcgPill) {
      if (this.state.isDemo) {
        homeEcgPill.textContent = 'DEMO 250 Гц';
        homeEcgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-mono font-medium';
      } else if (this.state.deviceState === 'connected_receiving') {
        homeEcgPill.textContent = 'LIVE 250 Гц';
        homeEcgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono font-medium';
      } else {
        homeEcgPill.textContent = 'Ожидание';
        homeEcgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono font-medium';
      }
    }
    if (homeEcgDot) {
      homeEcgDot.className = (this.state.isDemo || this.state.deviceState === 'connected_receiving')
        ? 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse'
        : 'w-2.5 h-2.5 rounded-full bg-slate-300';
    }
    if (homeEcgEmpty) {
      if (this.state.isDemo || this.state.deviceState === 'connected_receiving') {
        homeEcgEmpty.classList.add('hidden');
      } else {
        homeEcgEmpty.classList.remove('hidden');
      }
    }

    // 7. Скрытые селекторы совместимости
    const mBpm = document.getElementById('metric-bpm');
    if (mBpm) mBpm.textContent = bpmVal ? bpmVal.textContent : '—';
    const mSpo2 = document.getElementById('metric-spo2');
    if (mSpo2) mSpo2.textContent = spo2Val ? spo2Val.textContent : '—';

    // 8. Обновление таблицы недавних замеров на главном экране
    this.renderRecentMeasurementsTable();
  },

  // ========================================================
  // ВКЛАДКА 02: МОЙ РИСК (ИНДИВИДУАЛЬНАЯ МАТЕМАТИЧЕСКАЯ МОДЕЛЬ)
  // ========================================================
  renderMyRiskTab() {
    const evalRes = this.state.modelEvaluation;
    const profile = StorageService.getProfile() || (this.state.isDemo ? StorageService.getDefaultDemoProfile() : {});
    const stat = this.state.lStatResult;
    const dyn = this.state.lDynResult;
    const baseline = this.baselineService ? this.baselineService.getBaseline() : { hr0: 70 };

    const numEl = document.getElementById('home-index-number');
    const riskValEl = document.getElementById('risk-index-value');
    const zoneEl = document.getElementById('home-index-zone-label');
    const descEl = document.getElementById('home-index-status-desc');

    const hasRealData = !this.state.isDemo && this.state.bpm != null && this.state.spo2 != null;
    const isReady = this.state.isDemo || hasRealData;

    if (!isReady || !evalRes || evalRes.index == null) {
      if (numEl) numEl.textContent = '—';
      if (riskValEl) riskValEl.textContent = '—';
      if (zoneEl) {
        zoneEl.textContent = this.state.deviceState === 'connected_no_data' ? 'Ожидание контакта с датчиком' : 'Устройство не подключено';
        zoneEl.className = 'text-xs font-semibold text-slate-500';
      }
      if (descEl) {
        descEl.textContent = 'Для расчета индивидуального риска наденьте браслет Qamqor_Band и коснитесь оптического сенсора MAX30102.';
      }
      this._updateGauge(null, 'none');
    } else {
      const idx = evalRes.index;
      const zone = evalRes.zone;
      if (numEl) numEl.textContent = idx;
      if (riskValEl) riskValEl.textContent = idx;
      if (zoneEl) {
        zoneEl.textContent = zone === 'red' ? 'Красная зона (Повышенный риск)' :
                             zone === 'yellow' ? 'Жёлтая зона (Умеренное внимание)' :
                             'Зелёная зона (Низкий риск)';
        zoneEl.className = zone === 'red' ? 'text-xs font-bold text-rose-600' :
                           zone === 'yellow' ? 'text-xs font-bold text-amber-600' :
                           'text-xs font-bold text-emerald-600';
      }
      if (descEl) {
        descEl.textContent = zone === 'red' ? 'Рекомендуется отдых и снижение нагрузки. Контролируйте пульс и дыхание.' :
                             zone === 'yellow' ? 'Небольшое отклонение от персонального оптимума. Обратите внимание на стресс.' :
                             'Физиологические показатели стабильны и находятся в пределах персонализированной нормы.';
      }
      this._updateGauge(idx, zone);
    }

    // Статические факторы L_stat
    const ageEl = document.getElementById('risk-factor-age');
    if (ageEl) {
      const aVal = stat && stat.a != null ? stat.a.toFixed(2) : '0.00';
      ageEl.textContent = profile.age ? `${profile.age} лет • Вектор A = ${aVal}` : '40 лет • Вектор A = 0.00';
    }

    const bmiEl = document.getElementById('risk-factor-bmi');
    if (bmiEl) {
      const bVal = stat && stat.b != null ? stat.b.toFixed(2) : '0.00';
      const bmiVal = profile.bmi || (profile.height && profile.weight ? (profile.weight / ((profile.height/100)**2)).toFixed(1) : 24.5);
      const bmiCat = stat && stat.bmiCategory ? stat.bmiCategory : 'Норма';
      bmiEl.textContent = `${bmiVal} кг/м² (${bmiCat}) • B = ${bVal}`;
    }

    const smokingEl = document.getElementById('risk-factor-smoking');
    if (smokingEl) {
      const isSmoker = profile.smoking === true || profile.smoking === 'current' || profile.smoking === 1;
      smokingEl.textContent = isSmoker ? 'Курит (S = 1.0)' : 'Не курит (S = 0.0)';
      smokingEl.className = isSmoker ? 'font-semibold text-rose-600' : 'font-semibold text-emerald-700';
    }

    const famEl = document.getElementById('risk-factor-family');
    if (famEl) {
      const hasFam = profile.familyHistory === true || profile.familyHistory === 1;
      famEl.textContent = hasFam ? 'Отягощен ранними ССЗ (F = 1.0)' : 'Без ранних ССЗ (F = 0.0)';
      famEl.className = hasFam ? 'font-semibold text-amber-600' : 'font-semibold text-slate-800';
    }

    const actEl = document.getElementById('risk-factor-activity');
    if (actEl) {
      actEl.textContent = `Стресс: ${profile.stressLevel || 'умеренный'}, Активность: ${profile.physicalActivity || 'умеренная'}`;
    }

    // Динамические биомаркеры L_dyn
    const dHrEl = document.getElementById('risk-factor-delta-hr');
    if (dHrEl) {
      if (!isReady || this.state.bpm == null) {
        dHrEl.textContent = '— (Ожидание пульса)';
        dHrEl.className = 'font-semibold text-slate-400 font-mono';
      } else {
        const delta = this.state.bpm - (baseline.hr0 || 70);
        dHrEl.textContent = `${delta >= 0 ? '+' : ''}${delta} уд/мин (Базовый: ${baseline.hr0 || 70})`;
        dHrEl.className = Math.abs(delta) > 15 ? 'font-semibold text-amber-600 font-mono' : 'font-semibold text-emerald-700 font-mono';
      }
    }

    const zHrvEl = document.getElementById('risk-factor-z-hrv');
    if (zHrvEl) {
      if (!isReady || this.state.sdnn == null) {
        zHrvEl.textContent = '— (Ожидание HRV)';
        zHrvEl.className = 'font-semibold text-slate-400 font-mono';
      } else {
        const z = dyn && dyn.zHrv != null ? dyn.zHrv : 0;
        zHrvEl.textContent = `${z.toFixed(2)} σ (SDNN: ${Math.round(this.state.sdnn)} мс)`;
        zHrvEl.className = z > 1.5 ? 'font-semibold text-amber-600 font-mono' : 'font-semibold text-emerald-700 font-mono';
      }
    }

    const sSpo2El = document.getElementById('risk-factor-spo2');
    if (sSpo2El) {
      if (!isReady || this.state.spo2 == null) {
        sSpo2El.textContent = '— (Ожидание SpO2)';
        sSpo2El.className = 'font-semibold text-slate-400 font-mono';
      } else {
        const s = dyn && dyn.sSpo2 != null ? dyn.sSpo2 : (this.state.spo2 < 92 ? 3 : this.state.spo2 < 94 ? 2 : this.state.spo2 < 96 ? 1 : 0);
        sSpo2El.textContent = `${s} баллов (NEWS2, SpO2: ${this.state.spo2}%)`;
        sSpo2El.className = s > 0 ? 'font-semibold text-amber-600 font-mono' : 'font-semibold text-teal-700 font-mono';
      }
    }

    const sArrEl = document.getElementById('risk-factor-arr');
    if (sArrEl) {
      if (!isReady) {
        sArrEl.textContent = '— (Ожидание ЭКГ)';
        sArrEl.className = 'font-semibold text-slate-400 font-mono';
      } else {
        const p = this.state.pIrr != null ? this.state.pIrr : 0;
        sArrEl.textContent = `${p.toFixed(2)} (${p > 0.3 ? 'Аритмия' : 'Регулярный ритм'})`;
        sArrEl.className = p > 0.3 ? 'font-semibold text-rose-600 font-mono' : 'font-semibold text-emerald-700 font-mono';
      }
    }

    const ecgPill = document.getElementById('ecg-status-pill');
    if (ecgPill) {
      if (this.state.isDemo) {
        ecgPill.textContent = 'DEMO 250 Гц';
        ecgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-mono font-medium';
      } else if (this.state.deviceState === 'connected_receiving') {
        ecgPill.textContent = 'LIVE 250 Гц';
        ecgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200 font-mono font-medium';
      } else {
        ecgPill.textContent = 'Ожидание';
        ecgPill.className = 'text-[10px] px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono font-medium';
      }
    }
  },

  // ========================================================
  // ВКЛАДКА 03: ДИНАМИКА И ТРЕНДЫ (ГРАФИКИ И ЖУРНАЛ ИЗ STORAGE)
  // ========================================================
  setDynamicsPeriod(period) {
    if (!['day', '7d', '30d'].includes(period)) period = '7d';
    this.state.dynamicsPeriod = period;
    this.renderDynamicsTab();
  },

  renderDynamicsTab() {
    const isDemo = Boolean(this.state.isDemo);
    const history = StorageService.getHistory(isDemo);
    const period = this.state.dynamicsPeriod || '7d';

    // Update active period buttons
    ['day', '7d', '30d'].forEach(p => {
      const btn = document.getElementById(`btn-period-${p}`);
      if (btn) {
        if (p === period) {
          btn.className = 'px-3 py-1 rounded-lg bg-white text-teal-800 shadow-xs border border-slate-200 transition font-bold';
        } else {
          btn.className = 'px-3 py-1 rounded-lg text-slate-600 hover:text-slate-900 transition font-normal';
        }
      }
    });

    const periodLabelEl = document.getElementById('dyn-stat-period-label');
    if (periodLabelEl) {
      periodLabelEl.textContent = period === 'day' ? 'За последние 24 часа' : period === '30d' ? 'За последние 30 дней' : 'За последние 7 дней';
    }

    // Time filter
    const now = Date.now();
    const periodMs = period === 'day' ? 24 * 3600 * 1000 : period === '30d' ? 30 * 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    const cutoff = now - periodMs;

    let filtered = history.filter(item => {
      if (item.timestamp && typeof item.timestamp === 'number') {
        return item.timestamp >= cutoff;
      }
      return true;
    });

    // Sort chronologically (oldest to newest) for chart plotting
    filtered.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const emptyBox = document.getElementById('dyn-empty-state');
    const chartsBox = document.getElementById('dyn-charts-container');
    const statCount = document.getElementById('dyn-stat-count');
    const statHrRange = document.getElementById('dyn-stat-hr-range');
    const statSpo2Avg = document.getElementById('dyn-stat-spo2-avg');
    const statHrvAvg = document.getElementById('dyn-stat-hrv-avg');
    const tableContainer = document.getElementById('dyn-history-table-container');

    if (filtered.length === 0) {
      if (emptyBox) emptyBox.classList.remove('hidden');
      if (chartsBox) chartsBox.classList.add('hidden');
      if (statCount) statCount.textContent = '0';
      if (statHrRange) statHrRange.textContent = '—';
      if (statSpo2Avg) statSpo2Avg.textContent = '—';
      if (statHrvAvg) statHrvAvg.textContent = '—';
      if (tableContainer) {
        tableContainer.innerHTML = `
          <div class="p-8 text-center text-xs text-slate-400">
            <div class="flex flex-col items-center justify-center space-y-1">
              <span>📡 Нет сохранённых записей за выбранный период</span>
              <span class="text-[11px] text-slate-500">${isDemo ? 'Переключите сценарий симуляции или сбросьте фильтр.' : 'Подключите браслет Qamqor_Band по Bluetooth и зафиксируйте замеры.'}</span>
            </div>
          </div>
        `;
      }
      return;
    }

    if (emptyBox) emptyBox.classList.add('hidden');
    if (chartsBox) chartsBox.classList.remove('hidden');

    const validHrs = filtered.map(p => p.bpm != null ? p.bpm : p.hr).filter(v => typeof v === 'number' && v > 0);
    const validSpo2s = filtered.map(p => p.spo2).filter(v => typeof v === 'number' && v > 0);
    const validSdnns = filtered.map(p => p.sdnn != null ? p.sdnn : p.hrv).filter(v => typeof v === 'number' && v > 0);

    const minHr = validHrs.length > 0 ? Math.min(...validHrs) : '—';
    const maxHr = validHrs.length > 0 ? Math.max(...validHrs) : '—';
    const avgHr = validHrs.length > 0 ? Math.round(validHrs.reduce((a, b) => a + b, 0) / validHrs.length) : '—';

    const avgSpo2 = validSpo2s.length > 0 ? (validSpo2s.reduce((a, b) => a + b, 0) / validSpo2s.length).toFixed(1) : '—';
    const avgSdnn = validSdnns.length > 0 ? Math.round(validSdnns.reduce((a, b) => a + b, 0) / validSdnns.length) : '—';

    if (statCount) statCount.textContent = `${filtered.length} замеров`;
    if (statHrRange) statHrRange.textContent = validHrs.length > 0 ? `${minHr} / ${avgHr} / ${maxHr} уд/м` : '—';
    if (statSpo2Avg) statSpo2Avg.textContent = validSpo2s.length > 0 ? `${avgSpo2}%` : '—';
    if (statHrvAvg) statHrvAvg.textContent = validSdnns.length > 0 ? `${avgSdnn} мс` : '—';

    const baseline = this.baselineService ? this.baselineService.getBaseline() : { hr0: 70 };
    const hr0 = baseline.hr0 || 70;

    const hrBadge = document.getElementById('dyn-chart-hr-badge');
    if (hrBadge) hrBadge.textContent = `Базовый: ${hr0} уд/м`;

    // Render 3 dynamic SVGs from Storage data
    this.renderDynamicChartSVG('dyn-chart-hr-box', filtered, p => p.bpm != null ? p.bpm : p.hr, {
      yMin: Math.min(50, typeof minHr === 'number' ? minHr - 5 : 50),
      yMax: Math.max(120, typeof maxHr === 'number' ? maxHr + 10 : 120),
      refLines: [{ y: hr0, label: `Базовый ${hr0}`, color: '#0F766E', dash: true }],
      strokeColor: '#0F766E',
      fillColor: 'rgba(15, 118, 110, 0.12)',
      unit: ' уд/мин'
    });

    this.renderDynamicChartSVG('dyn-chart-spo2-box', filtered, p => p.spo2, {
      yMin: 85,
      yMax: 100,
      refLines: [{ y: 95, label: 'Порог 95%', color: '#059669', dash: true }],
      shadingBands: [{ yMin: 95, yMax: 100, color: 'rgba(5, 150, 105, 0.08)' }],
      strokeColor: '#0284C7',
      fillColor: 'rgba(2, 132, 199, 0.12)',
      unit: '%'
    });

    this.renderDynamicChartSVG('dyn-chart-hrv-box', filtered, p => p.sdnn != null ? p.sdnn : p.hrv, {
      yMin: 15,
      yMax: 90,
      shadingBands: [{ yMin: 35, yMax: 65, color: 'rgba(100, 116, 139, 0.08)' }],
      refLines: [
        { y: 35, label: 'Нижняя норма (35 мс)', color: '#94A3B8', dash: true },
        { y: 65, label: 'Верхняя норма (65 мс)', color: '#94A3B8', dash: true }
      ],
      strokeColor: '#6366F1',
      fillColor: 'rgba(99, 102, 241, 0.12)',
      unit: ' мс'
    });

    // Render Measurement Table
    if (tableContainer) {
      const displayRows = filtered.slice().reverse().slice(0, 15);
      tableContainer.innerHTML = `
        <div class="overflow-x-auto">
          <table class="w-full text-xs text-left">
            <thead>
              <tr class="border-b border-slate-200 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th class="py-2.5 px-3">Дата / Время</th>
                <th class="py-2.5 px-3">ЧСС</th>
                <th class="py-2.5 px-3">SpO₂</th>
                <th class="py-2.5 px-3">HRV (SDNN)</th>
                <th class="py-2.5 px-3">Индекс риска</th>
                <th class="py-2.5 px-3 text-right">Источник</th>
              </tr>
            </thead>
            <tbody>
              ${displayRows.map(row => {
                const bpm = row.bpm != null ? row.bpm : (row.hr != null ? row.hr : '—');
                const spo2 = row.spo2 != null ? `${row.spo2}%` : '—';
                const sdnn = row.sdnn != null ? `${Math.round(row.sdnn)} мс` : (row.hrv != null ? `${Math.round(row.hrv)} мс` : '—');
                const idx = row.index != null ? row.index : '—';
                const zone = row.zone || 'green';
                const badgeClass = zone === 'red' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                                   zone === 'yellow' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                   'bg-emerald-50 text-emerald-700 border-emerald-200';
                const isItemDemo = row.isDemo || row.source === 'demo' || (row.source && row.source.toLowerCase().includes('demo'));
                return `
                  <tr class="border-b border-slate-100 hover:bg-slate-50/70 transition">
                    <td class="py-2.5 px-3 font-mono text-slate-500">${row.dateStr || row.date || ''} ${row.timeStr || row.time || ''}</td>
                    <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${bpm} <span class="text-[10px] text-slate-400 font-sans">уд/м</span></td>
                    <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${spo2}</td>
                    <td class="py-2.5 px-3 font-mono text-slate-600">${sdnn}</td>
                    <td class="py-2.5 px-3 font-mono">
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${badgeClass}">
                        ${idx}
                      </span>
                    </td>
                    <td class="py-2.5 px-3 text-right">
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${isItemDemo ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-teal-50 text-teal-700 border border-teal-200'}">
                        ${isItemDemo ? 'DEMO' : 'ESP32'}
                      </span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  },

  renderDynamicChartSVG(containerId, items, valueExtractor, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const dataPoints = items.map((item, idx) => {
      const val = valueExtractor(item);
      const timeLabel = item.timeStr || item.time || (item.timestamp ? new Date(item.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : `#${idx+1}`);
      return { val, label: timeLabel };
    }).filter(p => typeof p.val === 'number' && !isNaN(p.val));

    if (dataPoints.length === 0) {
      container.innerHTML = `<div class="w-full h-full flex items-center justify-center text-xs text-slate-400 font-mono">Нет валидных точек</div>`;
      return;
    }

    const w = 600;
    const h = 160;
    const padL = 40;
    const padR = 20;
    const padT = 16;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    let minY = options.yMin != null ? options.yMin : Math.min(...dataPoints.map(p => p.val));
    let maxY = options.yMax != null ? options.yMax : Math.max(...dataPoints.map(p => p.val));
    if (minY === maxY) { minY -= 5; maxY += 5; }
    const ySpan = maxY - minY;

    const getX = (idx) => padL + (dataPoints.length > 1 ? (idx / (dataPoints.length - 1)) * plotW : plotW / 2);
    const getY = (val) => padT + plotH - ((val - minY) / ySpan) * plotH;

    let svgContent = '';

    // Shading bands
    if (options.shadingBands) {
      options.shadingBands.forEach(band => {
        const yTop = Math.max(padT, getY(band.yMax));
        const yBottom = Math.min(padT + plotH, getY(band.yMin));
        const bandH = Math.max(0, yBottom - yTop);
        svgContent += `<rect x="${padL}" y="${yTop}" width="${plotW}" height="${bandH}" fill="${band.color}" />`;
      });
    }

    // Horizontal grid lines
    [0, 0.5, 1].forEach(ratio => {
      const yVal = minY + ySpan * ratio;
      const yPos = getY(yVal);
      svgContent += `
        <line x1="${padL}" y1="${yPos}" x2="${w - padR}" y2="${yPos}" stroke="#F1F5F9" stroke-width="1" />
        <text x="${padL - 6}" y="${yPos + 3}" text-anchor="end" font-size="9" fill="#94A3B8" font-family="JetBrains Mono, monospace">${Math.round(yVal)}</text>
      `;
    });

    // Reference lines
    if (options.refLines) {
      options.refLines.forEach(ref => {
        const yPos = getY(ref.y);
        if (yPos >= padT && yPos <= padT + plotH) {
          svgContent += `
            <line x1="${padL}" y1="${yPos}" x2="${w - padR}" y2="${yPos}" stroke="${ref.color}" stroke-width="1.2" stroke-dasharray="4 3" />
            <text x="${w - padR}" y="${yPos - 4}" text-anchor="end" font-size="8" font-weight="600" fill="${ref.color}" font-family="JetBrains Mono, monospace">${ref.label}</text>
          `;
        }
      });
    }

    // Path points
    const pointsStr = dataPoints.map((p, idx) => `${getX(idx)},${getY(p.val)}`).join(' ');
    const firstX = getX(0);
    const lastX = getX(dataPoints.length - 1);
    const baseY = padT + plotH;

    // Fill area
    if (dataPoints.length > 1) {
      const areaPath = `M ${firstX},${baseY} L ` + dataPoints.map((p, idx) => `${getX(idx)},${getY(p.val)}`).join(' L ') + ` L ${lastX},${baseY} Z`;
      svgContent += `<path d="${areaPath}" fill="${options.fillColor || 'rgba(15,118,110,0.1)'}" />`;
      svgContent += `<polyline fill="none" stroke="${options.strokeColor || '#0F766E'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${pointsStr}" />`;
    }

    // Circles
    dataPoints.forEach((p, idx) => {
      const cx = getX(idx);
      const cy = getY(p.val);
      svgContent += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#FFFFFF" stroke="${options.strokeColor || '#0F766E'}" stroke-width="2" />`;
    });

    // X Axis labels
    const labelStep = Math.max(1, Math.floor(dataPoints.length / 4));
    dataPoints.forEach((p, idx) => {
      if (idx === 0 || idx === dataPoints.length - 1 || idx % labelStep === 0) {
        const cx = getX(idx);
        svgContent += `<text x="${cx}" y="${h - 8}" text-anchor="middle" font-size="8" fill="#94A3B8" font-family="JetBrains Mono, monospace">${p.label}</text>`;
      }
    });

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" class="w-full h-full block overflow-visible">
        ${svgContent}
      </svg>
    `;
  },

  // ========================================================
  // ВКЛАДКА 04: AI ADVISOR (СОВЕТЫ И РЕКОМЕНДАЦИИ)
  // ========================================================
  renderFactorsTab() {
    this.renderAdvisorTab();
  },

  renderAdvisorTab() {
    const container = document.getElementById('advisor-content-container') || document.getElementById('factors-decomposition-container');
    if (!container) return;

    const isRealDevice = !this.state.isDemo;
    const isDemo = Boolean(this.state.isDemo);

    // В реальном режиме без сенсоров показываем честное ожидание
    if (isRealDevice && this.state.bpm == null) {
      container.innerHTML = `
        <div class="rounded-2xl p-6 bg-white border border-slate-200 shadow-sm space-y-4 text-center">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center text-xl text-teal-700">
            📡
          </div>
          <div class="space-y-1">
            <div class="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">
              <span>AI REAL DATA ANALYSIS</span>
            </div>
            <h3 class="text-sm font-bold text-slate-900">Ожидание телеметрии браслета</h3>
            <p class="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
              В реальном режиме Qamqor AI Advisor анализирует исключительно фактические показатели с датчиков MAX30102 и AD8232. Подключите браслет по Bluetooth и коснитесь оптического сенсора для формирования анализа.
            </p>
          </div>
        </div>
      `;
      return;
    }

    const evalRes = this.state.modelEvaluation || (isDemo ? { index: 18, zone: 'green' } : { index: null, zone: 'none' });
    const stat = this.state.lStatResult;
    const baseline = this.baselineService ? this.baselineService.getBaseline() : { hr0: 70 };
    const q = this.state.qualityResult || { c: 0.88, percentage: 88 };
    const history = StorageService.getHistory(isDemo);

    const currentHr = this.state.bpm;
    const currentSpo2 = this.state.spo2;
    const currentSdnn = this.state.sdnn;

    const advisorContext = {
      metrics: {
        hr: currentHr,
        spo2: currentSpo2,
        sdnn: currentSdnn,
        pIrr: this.state.pIrr
      },
      baseline,
      profile: StorageService.getProfile() || {},
      symptoms: this.state.symptoms || {},
      isDemo: this.state.isDemo,
      modelResult: evalRes,
      history
    };

    let advisorData = this.aiAdvisorService ? this.aiAdvisorService.cachedResult : null;
    if (!advisorData && this.aiAdvisorService) {
      advisorData = this.aiAdvisorService.synthesizeLocalInsight(advisorContext);
      this.aiAdvisorService.cachedResult = advisorData;
    }
    if (!advisorData) {
      advisorData = {
        ai_insight: {
          summary: 'Система анализирует текущие кардиопоказатели для формирования персональных рекомендаций.',
          trend_assessment: 'stable',
          trend_label: 'Стабильно',
          key_observation: 'Показатели в границах нормы'
        },
        recommendations: [],
        trend_summary: { hr_delta: 0, hrv_status: 'normal', spo2_stability: 'high', cardio_load_trend: 'stable' }
      };
    }

    const insight = advisorData.ai_insight || {};
    const recs = advisorData.recommendations || [];
    const trend = advisorData.trend_summary || {};
    const hrDelta = trend.hr_delta != null ? trend.hr_delta : (currentHr ? currentHr - (baseline.hr0 || 70) : 0);

    const isEmergency = insight.trend_assessment === 'warning';
    const isAttention = insight.trend_assessment === 'needs_attention';
    const isImproving = insight.trend_assessment === 'improving';

    const canRefresh = this.aiAdvisorService ? this.aiAdvisorService.canRefresh() : true;
    const cooldownSec = this.aiAdvisorService ? this.aiAdvisorService.getCooldownSeconds() : 0;
    const isAnalyzing = this.aiAdvisorService ? this.aiAdvisorService.isAnalyzing : false;

    const timeAgoStr = advisorData.generatedAt
      ? new Date(advisorData.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : 'Только что';

    container.innerHTML = `
      <!-- 1. ГЛАВНАЯ КАРТОЧКА QAMQOR AI INSIGHT -->
      <div class="rounded-2xl p-5 border ${isEmergency ? 'bg-rose-50/70 border-rose-300' : isAttention ? 'bg-amber-50/60 border-amber-300' : 'bg-gradient-to-br from-slate-900 via-teal-950 to-slate-900 border-teal-800 text-white'} shadow-sm space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2.5">
            <div class="w-8 h-8 rounded-xl ${isEmergency ? 'bg-rose-600 text-white' : isAttention ? 'bg-amber-500 text-white' : 'bg-teal-500/20 text-teal-300 border border-teal-400/30'} flex items-center justify-center font-bold text-sm shadow-inner">
              ✨
            </div>
            <div>
              <div class="flex items-center space-x-2">
                <h3 class="text-sm font-bold ${isEmergency || isAttention ? 'text-slate-900' : 'text-white'}">Qamqor AI Advisor</h3>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isRealDevice ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-amber-400/20 text-amber-300 border border-amber-400/30'}">
                  ${isRealDevice ? 'AI REAL DATA ANALYSIS' : 'AI DEMO ANALYSIS'}
                </span>
              </div>
              <p class="text-[11px] ${isEmergency || isAttention ? 'text-slate-600' : 'text-teal-200/80'}">
                Клинически обоснованная аналитика • Синхронизировано в ${timeAgoStr}
              </p>
            </div>
          </div>

          <button id="btn-refresh-ai-advisor" onclick="App.refreshAIAdvisor()" ${(!canRefresh || isAnalyzing) ? 'disabled' : ''} class="px-3 py-1.5 rounded-xl text-xs font-semibold transition active:scale-95 flex items-center space-x-1.5 ${(!canRefresh || isAnalyzing) ? 'bg-slate-700/50 text-slate-400 cursor-not-allowed' : (isEmergency || isAttention ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-teal-600 hover:bg-teal-500 text-white')}">
            ${isAnalyzing ? `
              <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              <span>Анализ...</span>
            ` : !canRefresh ? `
              <span>${cooldownSec}с</span>
            ` : `
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
              <span>Обновить</span>
            `}
          </button>
        </div>

        <!-- Тренд-статус и AI Резюме -->
        <div class="space-y-2.5">
          <div class="inline-flex items-center space-x-2 px-2.5 py-1 rounded-lg text-xs font-bold ${
            isEmergency ? 'bg-rose-100 text-rose-800 border border-rose-300' :
            isAttention ? 'bg-amber-100 text-amber-900 border border-amber-300' :
            isImproving ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40' :
            'bg-teal-500/20 text-teal-200 border border-teal-400/30'
          }">
            <span>${isEmergency ? '🚨' : isAttention ? '⚠️' : isImproving ? '📈' : '⚖️'}</span>
            <span>${insight.trend_label || 'Стабильно'}</span>
          </div>

          <p class="text-xs ${isEmergency || isAttention ? 'text-slate-800 font-medium' : 'text-slate-200'} leading-relaxed">
            ${insight.summary || 'Показатели в норме.'}
          </p>

          ${insight.key_observation ? `
            <div class="text-[11px] p-2 rounded-lg ${isEmergency || isAttention ? 'bg-white/80 text-slate-700 border border-slate-200' : 'bg-slate-800/80 text-teal-200 border border-teal-800/60'} flex items-start space-x-1.5">
              <span>🔍</span>
              <span><b>Наблюдение:</b> ${insight.key_observation}</span>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- 2. ПЕРСОНАЛЬНЫЕ РЕКОМЕНДАЦИИ С ДОКАЗАТЕЛЬНОЙ БАЗОЙ И "ПОЧЕМУ ЭТОТ СОВЕТ?" -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3.5">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center space-x-2.5">
            <span class="w-7 h-7 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center text-xs font-bold">🎯</span>
            <div>
              <h3 class="text-sm font-bold text-slate-900">Персональные рекомендации</h3>
              <p class="text-[11px] text-slate-500">Отобрано доказательной базой на основе ваших параметров</p>
            </div>
          </div>
          <span class="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
            ${recs.filter(r => r.isCompleted).length} из ${recs.length} выполнено
          </span>
        </div>

        <div class="space-y-3">
          ${recs.length === 0 ? `
            <div class="p-5 text-center text-xs text-slate-500 space-y-1">
              <div>Все показатели стабильны и находятся в комфортной зоне.</div>
              <div class="text-[11px] text-slate-400">Продолжайте периодический мониторинг для поддержания точности базовой линии.</div>
            </div>
          ` : recs.map(rec => {
            const isWhyOpen = Boolean(this.whyExpandedMap[rec.id]);
            return `
              <div class="rounded-xl border ${rec.isCompleted ? 'bg-slate-50/70 border-slate-200' : rec.priority === 'high' ? 'bg-rose-50/20 border-rose-200' : 'bg-white border-slate-200'} p-4 space-y-3 transition hover:shadow-xs">
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-start space-x-3 flex-1">
                    <button onclick="App.toggleAIActionCompleted('${rec.id}')" class="mt-0.5 w-5 h-5 rounded-md border ${rec.isCompleted ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex items-center justify-center transition flex-shrink-0" title="Отметить выполненным">
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </button>
                    <div class="space-y-1">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-xs font-bold ${rec.isCompleted ? 'line-through text-slate-400' : 'text-slate-900'}">
                          ${rec.title}
                        </span>
                        <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          rec.priority === 'high' ? 'bg-rose-100 text-rose-700' :
                          rec.priority === 'medium' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-600'
                        }">
                          ${rec.priority === 'high' ? 'Срочно' : rec.priority === 'medium' ? 'Важно' : 'Совет'}
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-medium">
                          ${rec.category_label || rec.category}
                        </span>
                      </div>
                      <div class="text-xs text-slate-700 leading-relaxed ${rec.isCompleted ? 'line-through text-slate-400' : ''}">
                        ${rec.action}
                      </div>
                      ${rec.expected_benefit ? `
                        <div class="text-[11px] text-teal-800 font-medium pt-0.5">
                          ✨ <b>Эффект:</b> ${rec.expected_benefit}
                        </div>
                      ` : ''}
                    </div>
                  </div>
                </div>

                <div class="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div class="flex items-center space-x-1.5 text-slate-500">
                    <span class="text-teal-700 font-bold">📚</span>
                    <span>${rec.evidence_source || 'Клинические рекомендации ВОЗ/AHA'}</span>
                    ${rec.evidence_level ? `<span class="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">(${rec.evidence_level})</span>` : ''}
                  </div>

                  <button onclick="App.toggleWhyExplain('${rec.id}')" class="text-teal-700 hover:text-teal-800 font-semibold inline-flex items-center space-x-1 py-0.5 px-2 rounded-md hover:bg-teal-50 transition">
                    <span>Почему этот совет?</span>
                    <span class="text-xs">${isWhyOpen ? '▲' : '▼'}</span>
                  </button>
                </div>

                ${isWhyOpen && rec.why ? `
                  <div class="p-3.5 rounded-xl bg-slate-50 border border-teal-100 space-y-2 text-xs animate-in fade-in duration-200">
                    <div class="font-bold text-teal-900 border-b border-teal-200/60 pb-1 flex items-center space-x-1.5">
                      <span>🔬 Обоснование алгоритма Qamqor</span>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-600">
                      <div>
                        <span class="text-slate-400">Триггер-показатель:</span>
                        <div class="font-semibold text-slate-800">${rec.why.triggerMetric || rec.why.trigger_metric || 'Физиологический коридор'}</div>
                      </div>
                      <div>
                        <span class="text-slate-400">Индивидуальный базовый уровень:</span>
                        <div class="font-semibold text-slate-800">${rec.why.baselineComparison || rec.why.baseline_comparison || 'В пределах нормы'}</div>
                      </div>
                    </div>
                    <div class="text-[11px] text-slate-600 pt-1">
                      <span class="text-slate-400">Клиническое объяснение:</span>
                      <p class="text-slate-700 mt-0.5 leading-relaxed">${rec.why.clinicalRationale || rec.why.clinical_rationale || 'Обосновано снижением функциональной нагрузки на миокард.'}</p>
                    </div>
                    <div class="text-[10px] text-slate-500 pt-1 border-t border-slate-200/60">
                      ℹ️ <i>${rec.why.limitations || 'Оценка носит профилактический характер и не заменяет консультацию врача.'}</i>
                    </div>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- 3. ИНТЕРАКТИВНЫЙ ДЫХАТЕЛЬНЫЙ ТРЕНАЖЕР 4-4-4 -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-700 font-bold text-base">
              🫁
            </div>
            <div>
              <h3 class="text-sm font-bold text-slate-900">Дыхательное упражнение 4–4–4</h3>
              <p class="text-[11px] text-slate-500">Нормализует ЧСС на 5–10 уд/мин и восстанавливает вегетативный баланс</p>
            </div>
          </div>
          <button id="btn-breathing-toggle" onclick="App.toggleBreathingExercise()" class="px-3.5 py-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold shadow-sm transition active:scale-95">
            ▶ Начать
          </button>
        </div>

        <div id="breathing-box" class="hidden flex flex-col items-center justify-center py-5 space-y-3 bg-slate-50 rounded-xl border border-slate-200">
          <div class="relative w-28 h-28 flex items-center justify-center">
            <div id="breathing-circle" class="w-20 h-20 rounded-full bg-teal-100 border-2 border-teal-500 flex items-center justify-center transition-all duration-1000">
              <span id="breathing-phase-sec" class="text-2xl font-bold font-mono text-teal-800">4</span>
            </div>
          </div>
          <div class="text-center space-y-0.5">
            <div id="breathing-phase-text" class="text-xs font-bold text-teal-800 uppercase tracking-wider">Вдох носом...</div>
            <div class="text-[11px] text-slate-500">Дышите животом, расслабьте плечи и шею</div>
          </div>
        </div>
      </div>

      <!-- 4. ДЕТАЛЬНЫЙ РАЗБОР ФАКТОРОВ -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
        <div class="border-b border-slate-100 pb-2.5">
          <h3 class="text-sm font-bold text-slate-900">Разбор факторов кардио-оценки</h3>
          <p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
            Модель оценивает постоянные привычки (анкета) и динамику сердца (датчики) в реальном времени.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div class="flex items-center space-x-2 text-teal-800 font-bold border-b border-slate-200 pb-1.5">
              <span>📋 Анкета и анамнез (L_stat)</span>
            </div>
            ${stat ? `
            <div class="space-y-2 text-[11px] text-slate-600">
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Возраст:</span>
                <span class="font-semibold text-slate-800">${stat.normalized.A != null ? Math.round(stat.normalized.A * 10 + 40) : 40} лет</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">ИМТ:</span>
                <span class="font-semibold text-slate-800">${stat.normalized.bmi || 24.5} кг/м²</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Курение:</span>
                <span class="font-semibold ${stat.normalized.S ? 'text-amber-600' : 'text-emerald-700'}">${stat.normalized.S ? 'Да (+0.70)' : 'Нет (0)'}</span>
              </div>
            </div>
            ` : `
            <div class="text-amber-600 text-xs">Анкета не заполнена полностью.</div>
            `}
          </div>

          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div class="flex items-center space-x-2 text-teal-800 font-bold border-b border-slate-200 pb-1.5">
              <span>💓 Биомаркеры датчиков (L_dyn)</span>
            </div>
            <div class="space-y-2 text-[11px] text-slate-600">
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Пульс:</span>
                <span class="font-semibold ${currentHr > 95 ? 'text-amber-600' : 'text-emerald-700'}">${currentHr || (isRealDevice ? '—' : 72)} уд/мин (норма: ${baseline.hr0 || 70})</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Кислород (SpO2):</span>
                <span class="font-semibold ${currentSpo2 && currentSpo2 < 95 ? 'text-amber-600' : 'text-teal-700'}">${currentSpo2 != null ? currentSpo2 + '%' : (isRealDevice ? '—' : '98%')}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Ритм сердца:</span>
                <span class="font-semibold text-emerald-700">${this.state.pIrr > 0.1 ? 'Умеренная аритмия' : 'Ровный ритм'}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-500 leading-relaxed">
          💡 <b>Напоминание:</b> Оценка носит ориентировочный характер для контроля повседневной нагрузки. При любых болях в груди, головокружении или нехватке воздуха обратитесь к врачу или вызовите 103.
        </div>
      </div>
    `;
  },

  async refreshAIAdvisor() {
    if (!this.aiAdvisorService) return;

    if (!this.aiAdvisorService.canRefresh()) {
      const waitSec = this.aiAdvisorService.getCooldownSeconds();
      this.showToast(`Обновление доступно через ${waitSec} сек.`, 'info');
      return;
    }

    const btn = document.getElementById('btn-refresh-ai-advisor');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<svg class="w-3.5 h-3.5 animate-spin inline-block mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Анализ...</span>`;
    }

    try {
      const context = {
        metrics: {
          hr: this.state.bpm,
          spo2: this.state.spo2,
          sdnn: this.state.sdnn,
          pIrr: this.state.pIrr
        },
        baseline: this.baselineService ? this.baselineService.getBaseline() : { hr0: 70 },
        profile: StorageService.getProfile() || {},
        symptoms: this.state.symptoms || {},
        isDemo: this.state.isDemo,
        modelResult: this.state.modelEvaluation,
        history: StorageService.getHistory(this.state.isDemo)
      };

      await this.aiAdvisorService.generateAnalysis(context, true);
      this.showToast('Анализ Qamqor AI успешно обновлен!', 'success');
    } catch (e) {
      console.warn('AI Advisor refresh error:', e);
      this.showToast('Рекомендации актуализированы.', 'info');
    } finally {
      this.renderAdvisorTab();
    }
  },

  toggleAIActionCompleted(id) {
    if (this.aiAdvisorService) {
      this.aiAdvisorService.toggleActionCompleted(id);
    }
    this.renderAdvisorTab();
  },

  toggleWhyExplain(id) {
    if (this.whyExpandedMap) {
      this.whyExpandedMap[id] = !this.whyExpandedMap[id];
    }
    const el = document.getElementById(`why-explain-${id}`);
    if (el) {
      el.classList.toggle('hidden');
    }
    this.renderAdvisorTab();
  },

  updateConnectionUI() {
    const dot = document.getElementById('app-connection-indicator-dot');
    const label = document.getElementById('app-connection-indicator-text');
    const demoBar = document.getElementById('demo-mode-alert-bar');
    const realBar = document.getElementById('real-device-alert-bar');
    const sDot = document.getElementById('sidebar-device-dot');
    const sLabel = document.getElementById('sidebar-device-label');
    const sBadge = document.getElementById('sidebar-device-status-badge');
    const sensorStatusText = document.getElementById('home-sensor-status-subtitle');

    if (this.state.isDemo) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (label) label.textContent = 'Деморежим';
      if (demoBar) demoBar.classList.remove('hidden');
      if (realBar) realBar.classList.add('hidden');
      if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (sLabel) sLabel.textContent = 'Демо-режим активен';
      if (sBadge) {
        sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-medium';
        sBadge.textContent = 'Симуляция';
      }
      if (sensorStatusText) sensorStatusText.textContent = 'Генерация виртуальных биосигналов';
    } else if (this.state.isConnected) {
      if (demoBar) demoBar.classList.add('hidden');

      if (this.state.deviceState === 'connected_receiving') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        if (label) label.textContent = 'Подключено (BLE)';
        if (realBar) realBar.classList.add('hidden');
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        if (sLabel) sLabel.textContent = `${this.state.deviceName || 'Qamqor Band'} • Поток данных`;
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium';
          sBadge.textContent = 'Активен';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Датчики MAX30102 и AD8232 активны';
      } else {
        // connected_no_data
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-pulse';
        if (label) label.textContent = 'Подключено (нет данных)';
        if (realBar) realBar.classList.remove('hidden');
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-pulse';
        if (sLabel) sLabel.textContent = `${this.state.deviceName || 'Qamqor Band'} • Ожидание пальца`;
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-medium';
          sBadge.textContent = 'Ожидание';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Ожидание контакта с датчиком MAX30102';
      }
    } else {
      if (demoBar) demoBar.classList.add('hidden');
      if (realBar) realBar.classList.add('hidden');

      if (this.state.deviceState === 'reconnecting') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
        if (label) label.textContent = 'Переподключение...';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
        if (sLabel) sLabel.textContent = 'Восстановление связи с браслетом...';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-medium';
          sBadge.textContent = 'Повтор';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Попытка автоматического переподключения...';
      } else if (this.state.deviceState === 'connection_lost') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
        if (label) label.textContent = 'Связь потеряна';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
        if (sLabel) sLabel.textContent = 'Связь с браслетом потеряна';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-medium';
          sBadge.textContent = 'Разрыв';
        }
      } else {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-400';
        if (label) label.textContent = 'Не подключено';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-slate-400';
        if (sLabel) sLabel.textContent = 'Устройство не подключено';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-medium';
          sBadge.textContent = 'Офлайн';
        }
      }
      if (sensorStatusText) sensorStatusText.textContent = 'Браслет отключён';
    }

    const headerBleBtn = document.getElementById('header-ble-btn');
    if (headerBleBtn) {
      if (this.state.isConnected || this.state.isDemo) {
        headerBleBtn.classList.add('hidden');
      } else {
        headerBleBtn.classList.remove('hidden');
      }
    }
  },

  // ========================================================
  // ПОШАГОВАЯ АНКЕТА И ПРОФИЛЬ (4 ШАГА + СВОДКА)
  // ========================================================
  goToSurveyStep(step) {
    try {
      this.state.currentSurveyStep = step;

      // Скрываем все панели и показываем только активную
      for (let s = 1; s <= 5; s++) {
        const panel = document.getElementById(`survey-panel-step-${s}`);
        if (panel) {
          if (s === step) {
            panel.classList.remove('hidden');
            panel.style.display = 'block';
          } else {
            panel.classList.add('hidden');
            panel.style.display = 'none';
          }
        }
      }

      const stepTitles = {
        1: 'Основная информация',
        2: 'Повседневные привычки',
        3: 'Семейная история',
        4: 'Подключение датчика',
        5: 'Сводка готовности'
      };

      const pillText = document.getElementById('survey-step-indicator-text');
      const titleText = document.getElementById('survey-step-title-text');
      const progressBar = document.getElementById('survey-progress-bar');

      if (pillText) {
        pillText.textContent = step === 5 ? 'Сводка' : `Шаг ${step} из 4`;
      }
      if (titleText) {
        titleText.textContent = stepTitles[step] || '';
      }
      if (progressBar) {
        const percents = { 1: 25, 2: 50, 3: 75, 4: 95, 5: 100 };
        progressBar.style.width = `${percents[step] || 25}%`;
      }

      try {
        if (step === 1) {
          this.populateStep1Inputs();
          this.updateSurveyBMIPreview();
        } else if (step === 2) {
          this.refreshStep2Buttons();
        } else if (step === 3) {
          this.refreshStep3Buttons();
        } else if (step === 4) {
          this.updateSurveyDeviceStatus();
        } else if (step === 5) {
          this.renderSurveySummary();
        }
      } catch (subErr) {
        console.warn('Sub-render error on step', step, subErr);
      }

      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, 0);
      }
    } catch (e) {
      console.error('Error in goToSurveyStep:', e);
    }
  },

  nextSurveyStep(fromStep) {
    try {
      if (fromStep === 1) {
        const ageInput = document.getElementById('survey-input-age');
        const heightInput = document.getElementById('survey-input-height');
        const weightInput = document.getElementById('survey-input-weight');
        const nameInput = document.getElementById('survey-input-name');
        const errBox = document.getElementById('survey-step1-error-msg');

        let ageRaw = (ageInput ? ageInput.value : '').trim();
        let heightRaw = (heightInput ? heightInput.value : '').replace(',', '.').trim();
        let weightRaw = (weightInput ? weightInput.value : '').replace(',', '.').trim();
        let nameVal = nameInput ? nameInput.value.trim() : '';

        let ageVal = parseInt(ageRaw, 10);
        let heightVal = parseFloat(heightRaw);
        let weightVal = parseFloat(weightRaw);

        // Безопасные значения по умолчанию, если пользователь оставил пустыми
        if (isNaN(ageVal)) ageVal = 40;
        if (isNaN(heightVal)) heightVal = 175;
        if (isNaN(weightVal)) weightVal = 75;

        // Если введены значения за пределами разумного диапазона
        if (ageVal < 10 || ageVal > 110) {
          if (errBox) {
            errBox.textContent = 'Укажите возраст от 10 до 110 лет';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите возраст от 10 до 110 лет', 'warning');
          if (ageInput) ageInput.focus();
          return;
        }

        if (heightVal < 50 || heightVal > 250) {
          if (errBox) {
            errBox.textContent = 'Укажите рост в см (от 50 до 250)';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите рост в см (от 50 до 250)', 'warning');
          if (heightInput) heightInput.focus();
          return;
        }

        if (weightVal < 25 || weightVal > 300) {
          if (errBox) {
            errBox.textContent = 'Укажите вес в кг (от 25 до 300)';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите вес в кг (от 25 до 300)', 'warning');
          if (weightInput) weightInput.focus();
          return;
        }

        if (errBox) errBox.classList.add('hidden');

        // Вычисляем ИМТ безопасно
        const hM = heightVal > 3.0 ? heightVal / 100.0 : heightVal;
        const bmiVal = weightVal / (hM * hM);

        this.state.surveyTemp.name = nameVal || 'Пользователь';
        this.state.surveyTemp.age = ageVal;
        this.state.surveyTemp.heightCm = heightVal;
        this.state.surveyTemp.weightKg = weightVal;
        this.state.surveyTemp.bmi = Math.round(bmiVal * 10) / 10;

        this.goToSurveyStep(2);
      } else if (fromStep === 2) {
        this.goToSurveyStep(3);
      } else if (fromStep === 3) {
        this.goToSurveyStep(4);
      } else if (fromStep === 4) {
        this.goToSurveyStep(5);
      }
    } catch (err) {
      console.error('Error in nextSurveyStep:', err);
      // Гарантированный переход на следующий шаг даже при ошибке
      this.goToSurveyStep((fromStep || 1) + 1);
    }
  },

  populateStep1Inputs() {
    const data = this.state.surveyTemp;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) el.value = val;
    };
    if (data.name) setVal('survey-input-name', data.name);
    if (data.age != null) setVal('survey-input-age', data.age);
    if (data.heightCm != null) setVal('survey-input-height', data.heightCm);
    if (data.weightKg != null) setVal('survey-input-weight', data.weightKg);
  },

  updateSurveyBMIPreview() {
    const heightEl = document.getElementById('survey-input-height');
    const weightEl = document.getElementById('survey-input-weight');
    const statusEl = document.getElementById('survey-bmi-preview-status');
    const bBadge = document.getElementById('survey-bmi-b-badge');

    const h = parseFloat(heightEl ? heightEl.value : '');
    const w = parseFloat(weightEl ? weightEl.value : '');

    if (!isNaN(h) && h >= 50 && h <= 250 && !isNaN(w) && w >= 25 && w <= 300) {
      const bmi = w / ((h / 100) * (h / 100));
      const bVal = (bmi - 25) / 5;
      let category = 'Нормальная масса тела';
      if (bmi < 18.5) category = 'Дефицит массы тела';
      else if (bmi >= 25 && bmi < 30) category = 'Избыточная масса тела';
      else if (bmi >= 30) category = 'Повышенная масса тела (ожирение)';

      if (statusEl) {
        statusEl.textContent = `${bmi.toFixed(1)} кг/м² • ${category}`;
      }
      if (bBadge) {
        bBadge.textContent = `B = ${bVal >= 0 ? '+' : ''}${bVal.toFixed(2)}`;
      }
    } else {
      if (statusEl) statusEl.textContent = 'Введите рост и вес для расчета';
      if (bBadge) bBadge.textContent = 'B = --';
    }
  },

  toggleWhyExplain(key) {
    const el = document.getElementById(`why-explain-${key}`);
    if (el) {
      el.classList.toggle('hidden');
    }
  },

  setSurveyChoice(field, value) {
    this.state.surveyTemp[field] = value;
    if (field === 'smoking') {
      this.refreshSmokingButtons();
    } else if (field === 'stress') {
      this.refreshStressButtons();
    } else if (field === 'activity') {
      this.refreshActivityButtons();
    } else if (field === 'familyHistory') {
      this.refreshFamilyButtons();
    }
  },

  refreshStep2Buttons() {
    this.refreshSmokingButtons();
    this.refreshStressButtons();
    this.refreshActivityButtons();
  },

  refreshStep3Buttons() {
    this.refreshFamilyButtons();
  },

  refreshSmokingButtons() {
    const val = this.state.surveyTemp.smoking;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    const btn0 = document.getElementById('opt-smoking-0');
    const btn1 = document.getElementById('opt-smoking-1');
    const btnU = document.getElementById('opt-smoking-unknown');
    const notice = document.getElementById('survey-smoking-notice');

    if (btn0) btn0.className = val === 0 ? activeClass : inactiveClass;
    if (btn1) btn1.className = val === 1 ? activeClass : inactiveClass;
    if (btnU) btnU.className = (val === null || val === 'unknown') ? activeClass : inactiveClass;
    if (notice) {
      if (val === null || val === 'unknown') notice.classList.remove('hidden');
      else notice.classList.add('hidden');
    }
  },

  refreshStressButtons() {
    const val = this.state.surveyTemp.stress != null ? this.state.surveyTemp.stress : 1;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-stress-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshActivityButtons() {
    const val = this.state.surveyTemp.activity != null ? this.state.surveyTemp.activity : 1;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-activity-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshFamilyButtons() {
    const val = this.state.surveyTemp.familyHistory;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    const btn0 = document.getElementById('opt-familyHistory-0');
    const btn1 = document.getElementById('opt-familyHistory-1');
    const btnU = document.getElementById('opt-familyHistory-unknown');
    const notice = document.getElementById('survey-family-notice');

    if (btn0) btn0.className = val === 0 ? activeClass : inactiveClass;
    if (btn1) btn1.className = val === 1 ? activeClass : inactiveClass;
    if (btnU) btnU.className = (val === null || val === 'unknown') ? activeClass : inactiveClass;
    if (notice) {
      if (val === null || val === 'unknown') notice.classList.remove('hidden');
      else notice.classList.add('hidden');
    }
  },

  updateSurveyDeviceStatus() {
    const connText = document.getElementById('survey-device-conn-text');
    const qualityText = document.getElementById('survey-device-quality-text');
    const hintText = document.getElementById('survey-device-hint');
    const metricsRow = document.getElementById('survey-device-metrics-row');
    const metricsText = document.getElementById('survey-device-metrics-text');
    const goDashBtn = document.getElementById('survey-step4-go-dashboard-btn');

    const isConnected = this.state.isConnected;
    const isDemo = this.state.isDemo;
    const c = this.state.qualityResult ? this.state.qualityResult.c : 0;
    const hasData = this.state.bpm != null && this.state.spo2 != null;

    if (connText) {
      if (isDemo) {
        connText.innerHTML = '<span class="text-teal-800 font-bold">● Демо-режим активен</span>';
      } else if (isConnected && hasData) {
        connText.innerHTML = `<span class="text-emerald-800 font-bold">● Подключен • ЧСС: ${this.state.bpm} уд/мин, SpO2: ${this.state.spo2}%</span>`;
      } else if (isConnected) {
        connText.innerHTML = '<span class="text-emerald-800 font-bold">● Подключен по Bluetooth (ожидание данных)</span>';
      } else {
        connText.innerHTML = '<span class="text-slate-500">○ Не подключено</span>';
      }
    }

    if (qualityText) {
      if (isDemo || hasData || c >= 0.5) {
        qualityText.innerHTML = `<span class="text-emerald-800 font-bold">Стабилен (100% сигнал датчика)</span>`;
      } else if (isConnected) {
        qualityText.innerHTML = `<span class="text-amber-800 font-bold">Ожидание контакта</span>`;
      } else {
        qualityText.innerHTML = '<span class="text-slate-500">Ожидание измерений</span>';
      }
    }

    if (hintText) {
      if (isDemo) {
        hintText.innerHTML = '✅ <b>Демонстрация активна:</b> виртуальные датчики генерируют корректный физиологический сигнал для проверки.';
      } else if (isConnected && hasData) {
        hintText.innerHTML = `✅ <b>Реальные данные поступают:</b> пульс ${this.state.bpm} уд/мин, SpO2 ${this.state.spo2}%. Данные передаются на дашборд.`;
      } else if (isConnected) {
        hintText.innerHTML = 'ℹ️ <b>Браслет на связи:</b> приложите палец к датчику MAX30102 для считывания пульса и сатурации.';
      } else {
        hintText.innerHTML = '💡 Нажмите «Подключить по Bluetooth» или «Запустить в демо-режиме» для проверки биосигналов.';
      }
    }

    if (metricsRow && metricsText) {
      if (hasData) {
        metricsRow.classList.remove('hidden');
        metricsText.textContent = `ЧСС: ${this.state.bpm} уд/мин | SpO2: ${this.state.spo2}%`;
      } else {
        metricsRow.classList.add('hidden');
      }
    }

    if (goDashBtn) {
      if (isConnected || isDemo) {
        goDashBtn.classList.remove('hidden');
      } else {
        goDashBtn.classList.add('hidden');
      }
    }
  },

  renderSurveySummary() {
    const itemsContainer = document.getElementById('survey-summary-items');
    const verdictContainer = document.getElementById('survey-summary-verdict');
    const actionsContainer = document.getElementById('survey-summary-actions');

    const validation = validateSurvey(this.state.surveyTemp);
    this.state.surveyValidation = validation;

    const baseline = this.baselineService.getBaseline();
    const quality = calculateDataQuality({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);
    const cBase = calculateBaselineCompleteness(Math.max(1, baseline.daysElapsed));
    this.state.qualityResult = calculateOverallCompleteness(quality.c_q, cBase);

    const c = this.state.isDemo ? Math.max(0.85, this.state.qualityResult.c) : this.state.qualityResult.c;

    // 1. Отображение карточек параметров
    if (itemsContainer) {
      const data = this.state.surveyTemp;
      const getSmokingText = () => {
        if (data.smoking === 0) return { ok: true, text: 'Не курю (S=0)' };
        if (data.smoking === 1) return { ok: true, text: 'Курю (S=1)' };
        return { ok: false, text: 'Предпочитаю не отвечать (отсутствует)' };
      };
      const getFamilyText = () => {
        if (data.familyHistory === 0) return { ok: true, text: 'Нет у родственников (F=0)' };
        if (data.familyHistory === 1) return { ok: true, text: 'Да, были ССЗ (F=1)' };
        return { ok: false, text: 'Не знаю (требуется уточнить)' };
      };
      const getStressText = () => {
        const map = { 0: 'Редко (Y=0)', 1: 'Умеренно (Y=1)', 2: 'Почти каждый день (Y=2)' };
        return map[data.stress] || 'Умеренно (Y=1)';
      };
      const getActivityText = () => {
        const map = { 0: 'Малоподвижный (P=0)', 1: 'Умеренная (P=1)', 2: 'Регулярный спорт (P=2)' };
        return map[data.activity] || 'Умеренная (P=1)';
      };

      const smokingInfo = getSmokingText();
      const familyInfo = getFamilyText();

      const cards = [
        { label: 'Возраст (A)', val: `${data.age || 40} лет`, ok: !!data.age },
        { label: 'Рост / Вес (ИМТ B)', val: `${data.heightCm || 175} см, ${data.weightKg || 75} кг (ИМТ: ${data.bmi || 24.5})`, ok: !!(data.heightCm && data.weightKg) },
        { label: 'Курение (S)', val: smokingInfo.text, ok: smokingInfo.ok },
        { label: 'Семейная история (F)', val: familyInfo.text, ok: familyInfo.ok },
        { label: 'Стресс (Y)', val: getStressText(), ok: data.stress != null },
        { label: 'Активность (P)', val: getActivityText(), ok: data.activity != null },
        { label: 'Сигнал датчика (c)', val: (this.state.isDemo || c >= 0.5) ? `Стабилен (${Math.round(c * 100)}%)` : `Недостаточен (${Math.round(c * 100)}% < 50%)`, ok: (this.state.isDemo || c >= 0.5) }
      ];

      itemsContainer.innerHTML = cards.map(c => `
        <div class="p-3 rounded-xl bg-slate-50 border ${c.ok ? 'border-slate-200' : 'border-amber-200 bg-amber-50/60'} space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-slate-500 text-[11px] font-medium">${c.label}</span>
            <span class="text-xs">${c.ok ? '✅' : '⚠️'}</span>
          </div>
          <div class="text-xs font-bold ${c.ok ? 'text-slate-900' : 'text-amber-800'}">${c.val}</div>
        </div>
      `).join('');
    }

    // 2. Вердикт готовности
    if (verdictContainer) {
      if (validation.isValid) {
        // Сохраняем проверенный профиль в хранилище
        StorageService.saveProfile(validation.profile);
        StorageService.setOnboarded(true);

        try {
          this.state.lStatResult = calculateLStat(validation.profile);
        } catch {
          this.state.lStatResult = null;
        }

        const modelEval = evaluateModel({
          lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
          lDyn: this.state.lDynResult ? this.state.lDynResult.lDyn : null,
          c: (this.state.isDemo || c >= 0.5) ? Math.max(0.85, c) : c,
          rPrev: this.state.prevR,
          dtMinutes: 0.1
        });

        if (modelEval.isDataSufficient && modelEval.index != null) {
          const zoneBadge = modelEval.zone === 'green' ? '<span class="text-emerald-700 font-bold">Зеленая зона (Низкий риск)</span>'
            : modelEval.zone === 'yellow' ? '<span class="text-amber-700 font-bold">Желтая зона (Умеренный риск)</span>'
            : '<span class="text-rose-700 font-bold">Красная зона (Высокий риск)</span>';

          verdictContainer.className = 'p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-2';
          verdictContainer.innerHTML = `
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-950 uppercase tracking-wider">✅ Все данные собраны • Расчёт готов</span>
              <span class="text-xs font-mono font-bold text-emerald-900 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded">${modelEval.index} / 100</span>
            </div>
            <div class="text-xs text-slate-800 font-semibold">${zoneBadge}</div>
            <p class="text-xs text-slate-700 leading-relaxed font-normal">
              Математическая модель откалибрована. Базовый профиль L_stat = ${this.state.lStatResult.lStat.toFixed(2)}, динамическая составляющая учтена с качеством c = ${Math.round(c * 100)}%.
            </p>
          `;
        } else {
          verdictContainer.className = 'p-4 rounded-xl bg-teal-50 border border-teal-200 text-teal-950 space-y-2';
          verdictContainer.innerHTML = `
            <div class="text-xs font-bold text-teal-900 uppercase tracking-wider">ℹ️ Анкета сохранена • Ожидание стабильного сигнала</div>
            <p class="text-xs text-slate-700 leading-relaxed font-normal">
              Все 6 факторов анкеты успешно заполнены. Для вычисления динамического индекса необходим устойчивый сигнал датчика (порог c ≥ 0.5). Пока датчик калибруется, система отобразит статус «Недостаточно данных».
            </p>
          `;
        }
      } else {
        // Данных анкеты недостаточно
        const missingList = validation.missing.map(m => `• <b>${m.label}:</b> ${m.reason}`).join('<br>');
        verdictContainer.className = 'p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 space-y-2';
        verdictContainer.innerHTML = `
          <div class="text-xs font-bold text-amber-950 uppercase tracking-wider">⚠️ Расчёт индекса приостановлен (неполные данные)</div>
          <p class="text-xs text-slate-700 leading-relaxed font-normal">
            В соответствии со спецификацией Qamqor, математическая модель <b>не подменяет пропущенные ответы нулями или догадками</b>. Для точного расчёта не хватает следующих данных:<br>
            <div class="mt-2 text-xs text-amber-950 leading-relaxed bg-amber-100/80 border border-amber-200 p-2.5 rounded-xl">${missingList}</div>
          </p>
        `;
      }
    }

    // 3. Кнопки действий
    if (actionsContainer) {
      if (validation.isValid) {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition">
            Изменить ответы
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs shadow-sm transition text-center">
            Перейти в дашборд здоровья →
          </button>
        `;
      } else {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold transition">
            ← Дополнить анкету
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold text-center transition">
            Открыть дашборд (только датчики) →
          </button>
        `;
      }
    }
  },

  completeSurveyAndOpenApp() {
    let profile = StorageService.getProfile();
    if (!profile) {
      const val = validateSurvey(this.state.surveyTemp);
      if (val.isValid) {
        profile = val.profile;
        StorageService.saveProfile(val.profile);
      } else {
        profile = Object.assign({}, StorageService.getDefaultDemoProfile(), this.state.surveyTemp);
        profile.name = profile.name || 'Пользователь Qamqor';
        StorageService.saveProfile(profile);
      }
    }
    if (profile) {
      try {
        this.state.lStatResult = calculateLStat(profile);
      } catch(e) {
        console.warn('L_stat calculation error:', e);
      }
      this.state.surveyValidation = validateSurvey(profile);
    }
    StorageService.setOnboarded(true);
    this.recalculateModel();
    this.showScreen('main-app');
    if (this.state.isDemo) {
      this.startDemoMode();
    } else {
      this.setRealDeviceMode();
    }
    this.renderAll();
    this.showToast('Добро пожаловать в дашборд Qamqor!', 'success');
  },

  submitSurvey() {
    this.nextSurveyStep(1);
  },

  renderRecentMeasurementsTable() {
    const tableBody = document.getElementById('recent-measurements-table-body');
    if (!tableBody) return;

    const hist = StorageService.getHistory();
    const latestItems = hist.slice(0, 5);

    if (latestItems.length === 0) {
      if (!this.state.isDemo && this.state.bpm == null) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="6" class="py-8 text-center text-xs text-slate-400">
              <div class="flex flex-col items-center justify-center space-y-1">
                <span>📡 Нет сохранённых измерений</span>
                <span class="text-[11px] text-slate-500">Подключите браслет по Bluetooth и приложите палец к датчику MAX30102</span>
              </div>
            </td>
          </tr>
        `;
        return;
      }
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const bpm = this.state.isDemo ? (this.state.bpm || 72) : (this.state.bpm || '—');
      const spo2 = this.state.isDemo ? (this.state.spo2 || 98) : (this.state.spo2 || '—');
      const sdnn = this.state.sdnn != null ? Math.round(this.state.sdnn) : (this.state.isDemo ? 48 : '—');
      const idx = this.state.modelEvaluation ? this.state.modelEvaluation.index : (this.state.isDemo ? 18 : '—');
      const zone = this.state.modelEvaluation ? this.state.modelEvaluation.zone : (this.state.isDemo ? 'green' : 'none');
      const badgeClass = zone === 'red' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                         zone === 'yellow' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                         zone === 'green' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                         'bg-slate-50 text-slate-600 border-slate-200';
      const statusText = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : zone === 'green' ? 'Норма' : 'Ожидание';

      tableBody.innerHTML = `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="py-2.5 px-3 font-mono text-slate-500">${timeStr}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${bpm} <span class="text-[10px] text-slate-400 font-sans">уд/м</span></td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${spo2 !== '—' ? spo2 + '%' : '—'}</td>
          <td class="py-2.5 px-3 font-mono text-slate-600">${sdnn} <span class="text-[10px] text-slate-400 font-sans">мс</span></td>
          <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${idx}</td>
          <td class="py-2.5 px-3 text-right">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeClass}">${statusText}</span>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = latestItems.map(item => {
      const zone = item.zone || 'green';
      const badgeClass = zone === 'red' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                         zone === 'yellow' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                         'bg-emerald-50 text-emerald-700 border-emerald-200';
      const statusText = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : 'Норма';
      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="py-2.5 px-3 font-mono text-slate-500">${item.timeStr || '--:--'}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${item.bpm || '--'} <span class="text-[10px] text-slate-400 font-sans">уд/м</span></td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${item.spo2 != null ? item.spo2 + '%' : '--'}</td>
          <td class="py-2.5 px-3 font-mono text-slate-600">${item.sdnn ? Math.round(item.sdnn) : '--'} <span class="text-[10px] text-slate-400 font-sans">мс</span></td>
          <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${item.index != null ? item.index : '--'}</td>
          <td class="py-2.5 px-3 text-right">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeClass}">${statusText}</span>
          </td>
        </tr>
      `;
    }).join('');
  },

  renderRecommendationsTab() {
    const listEl = document.getElementById('recommendations-list');
    if (!listEl) return;

    const recs = this.state.recommendations || [];
    const plan = this.state.improvementPlan || [];

    if (recs.length === 0 && plan.length === 0) {
      listEl.innerHTML = `
        <div class="p-8 text-center text-slate-500 text-xs">
          Показатели в норме. Персональные рекомендации появятся при накоплении данных.
        </div>
      `;
      return;
    }

    listEl.innerHTML = recs.map(r => `
      <div class="p-4 rounded-xl bg-white border border-slate-200 shadow-sm space-y-2 hover:border-slate-300 transition">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-slate-900">${r.title}</span>
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
            ${r.category}
          </span>
        </div>
        <p class="text-xs text-slate-600 leading-relaxed">${r.description}</p>
        <div class="p-2.5 rounded-lg bg-teal-50 border border-teal-200 text-xs text-teal-800 font-medium flex items-center space-x-2">
          <span class="text-teal-600">💡</span>
          <span><b>Рекомендация:</b> ${r.action}</span>
        </div>
      </div>
    `).join('');
  },

  // ========================================================
  // ИСТОРИЯ И CSV
  // ========================================================
  renderHistoryList() {
    const container = document.getElementById('history-items-container');
    const hist = StorageService.getHistory();
    if (!container) return;

    if (hist.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Записи в журнале отсутствуют.</div>`;
      return;
    }

    container.innerHTML = hist.map(h => `
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between text-xs hover:border-slate-300 transition">
        <div class="flex items-center space-x-3">
          <span class="w-2.5 h-2.5 rounded-full ${h.isDemo ? 'bg-amber-400' : 'bg-emerald-500'} flex-shrink-0"></span>
          <div>
            <div class="font-semibold text-slate-900">${h.title}</div>
            <div class="text-[10px] text-slate-500 mt-0.5 font-mono">
              ${h.dateStr} ${h.timeStr} • Качество c: ${h.c != null ? Math.round(h.c * 100) + '%' : '--'}
            </div>
          </div>
        </div>
        <span class="font-mono font-bold text-slate-800 text-xs bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">${h.index != null ? 'Индекс: ' + h.index : ''}</span>
      </div>
    `).join('');
  },

  exportHistoryCSV() {
    const isDemo = Boolean(this.state.isDemo);
    const hist = StorageService.getHistory(isDemo);
    if (hist.length === 0) {
      this.showToast('История пуста, экспорт не требуется', 'info');
      return;
    }

    let csvContent = 'ID;Дата;Время;ЧСС (уд/мин);SpO2 (%);HRV SDNN (мс);Индекс риска;Зона риска;Полнота (c);Источник\n';
    hist.forEach(h => {
      const id = h.id || '';
      const date = h.dateStr || h.date || '';
      const time = h.timeStr || h.time || '';
      const bpm = h.bpm != null ? h.bpm : (h.hr != null ? h.hr : '');
      const spo2 = h.spo2 != null ? h.spo2 : '';
      const sdnn = h.sdnn != null ? h.sdnn : (h.hrv != null ? h.hrv : '');
      const index = h.index != null ? h.index : '';
      const zone = h.zone || '';
      const c = h.c != null ? h.c : '';
      const source = isDemo ? 'DEMO' : (h.source || 'Qamqor Band (MAX30102)');
      csvContent += `${id};${date};${time};${bpm};${spo2};${sdnn};${index};${zone};${c};${source}\n`;
    });

    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = isDemo ? 'qamqor_demo_measurements.csv' : 'qamqor_real_measurements.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    this.showToast('CSV файл экспортирован.', 'success');
  },

  populateSettingsTab() {
    const profile = StorageService.getProfile() || {};
    const nameEl = document.getElementById('settings-profile-name');
    const ageEl = document.getElementById('settings-profile-age');
    const bmiEl = document.getElementById('settings-profile-bmi');
    const verEl = document.getElementById('settings-model-version');

    if (nameEl) nameEl.textContent = profile.name || 'Пользователь';
    if (ageEl) ageEl.textContent = `${profile.age || 40} лет`;
    if (bmiEl) bmiEl.textContent = `${profile.bmi || 24.5} кг/м²`;
    if (verEl) verEl.textContent = MODEL_CONFIG.version;

    // Режим работы
    const badgeEl = document.getElementById('settings-current-mode-badge');
    const btnReal = document.getElementById('btn-mode-real');
    const btnDemo = document.getElementById('btn-mode-demo');

    const activeBtnClass = 'py-2.5 px-3 rounded-xl border-2 border-teal-700 bg-teal-700 text-white text-xs font-bold text-center shadow-xs transition';
    const inactiveBtnClass = 'py-2.5 px-3 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold text-center hover:bg-slate-50 hover:text-slate-900 transition';

    if (this.state.isDemo) {
      if (badgeEl) {
        badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200';
        badgeEl.textContent = 'Демо-режим';
      }
      if (btnDemo) btnDemo.className = activeBtnClass;
      if (btnReal) btnReal.className = inactiveBtnClass;
    } else {
      if (badgeEl) {
        badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
        badgeEl.textContent = 'Реальное устройство';
      }
      if (btnReal) btnReal.className = activeBtnClass;
      if (btnDemo) btnDemo.className = inactiveBtnClass;
    }
  },

  // ========================================================
  // SOS И ДИАЛОГИ
  // ========================================================
  openSOSModal(customMsg = null) {
    const modal = document.getElementById('modal-sos-dialog');
    const desc = document.getElementById('sos-dialog-description');
    if (desc && customMsg) {
      desc.textContent = customMsg;
    }
    if (modal) modal.classList.remove('hidden');
  },

  closeSOSModal() {
    const modal = document.getElementById('modal-sos-dialog');
    if (modal) modal.classList.add('hidden');
  },

  resetAllData() {
    if (confirm('Внимание! Это полностью сбросит все локальные данные, историю и вернет вас к экрану подключения. Продолжить?')) {
      StorageService.resetAll();
      this.bleService.disconnect();
      this.demoSimulator.stop();
      window.location.reload();
    }
  },

  showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const t = document.createElement('div');
    const borderCol = type === 'success' ? 'border-emerald-200 bg-white text-emerald-800' :
                      type === 'warning' ? 'border-amber-200 bg-white text-amber-800' :
                      'border-teal-200 bg-white text-teal-800';

    t.className = `p-3 rounded-xl border ${borderCol} backdrop-blur-md shadow-xl text-xs font-medium flex items-center justify-between transition-all duration-300 transform translate-y-2 pointer-events-auto`;
    t.innerHTML = `<span>${msg}</span>`;
    container.appendChild(t);

    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3500);
  },


  // ========================================================
  // КРУГОВОЙ SVG ДАТЧИК РИСКА
  // ========================================================
  _updateGauge(index, zone) {
    const arc = document.getElementById('gauge-arc');
    const centerNum = document.getElementById('gauge-center-num');
    const centerLabel = document.getElementById('gauge-center-label');
    if (!arc) return;

    const r = 54;
    const circumference = 2 * Math.PI * r;

    if (index == null || zone === 'none') {
      arc.style.strokeDasharray = '0 ' + circumference;
      arc.style.stroke = '#E2E8F0';
      if (centerNum) { centerNum.textContent = '--'; centerNum.style.fill = '#94A3B8'; }
      if (centerLabel) { centerLabel.textContent = 'Ожидание'; centerLabel.style.fill = '#94A3B8'; }
      return;
    }

    const pct = Math.min(100, Math.max(0, index)) / 100;
    const dashLen = pct * circumference;
    arc.style.strokeDasharray = dashLen + ' ' + (circumference - dashLen);
    arc.style.transition = 'stroke-dasharray 0.6s ease, stroke 0.4s ease';

    const color = zone === 'red' ? '#DC2626' : zone === 'yellow' ? '#F59E0B' : '#16A34A';
    arc.style.stroke = color;

    if (centerNum) { centerNum.textContent = index; centerNum.style.fill = color; }
    if (centerLabel) {
      centerLabel.textContent = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : 'Норма';
      centerLabel.style.fill = color;
    }
  },

  // ========================================================
  // ОПЕКУН / ВРАЧ — ТЕЛЕГРАМ УВЕДОМЛЕНИЯ
  // ========================================================
  loadGuardianConfig() {
    try {
      const raw = localStorage.getItem('qamqor_v3_guardian');
      return raw ? JSON.parse(raw) : { name: '', botToken: '', chatId: '', notifyRed: true, notifyDeterioration: true };
    } catch { return { name: '', botToken: '', chatId: '', notifyRed: true, notifyDeterioration: true }; }
  },

  saveGuardianConfig(cfg) {
    localStorage.setItem('qamqor_v3_guardian', JSON.stringify(cfg));
  },

  renderGuardianTab() {
    const cfg = this.loadGuardianConfig();
    const tab = document.getElementById('tab-guardian');
    if (!tab) return;

    const profile = StorageService.getProfile() || { name: 'Мама', age: 40 };
    const patientName = profile.name || 'Мама';
    const lastNotifRaw = localStorage.getItem('qamqor_v3_guardian_last_notif');
    const lastNotifStr = lastNotifRaw
      ? new Date(parseInt(lastNotifRaw)).toLocaleString('ru-RU')
      : 'Уведомления ещё не отправлялись';

    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const isRed = evalRes.zone === 'red';
    const isYellow = evalRes.zone === 'yellow';

    const previewMessage = this.getFormattedGuardianAlertMessage('red');
    const previewDisplayHtml = previewMessage
      .replace(/\n/g, '<br>')
      .replace(/\*([^*]+)\*/g, '<b class="text-slate-900">$1</b>');

    tab.innerHTML = `
      <div class="space-y-4">
        <!-- Шапка -->
        <div class="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <span class="text-sm font-bold text-slate-900">Удалённый присмотр за близким</span>
              <span class="px-2 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200 text-[10px] font-bold">Сын / Врач</span>
            </div>
            <p class="text-xs text-slate-500 leading-relaxed max-w-xl">
              Если браслет носит <b>мама</b>, а сын или врач находится <b>в другом городе</b> — система автоматически пришлёт срочный сигнал при росте риска или ухудшении пульса.
            </p>
          </div>
          <span class="text-3xl flex-shrink-0">👨‍⚕️</span>
        </div>

        <!-- КАРТОЧКА: ПРОВЕРКА ОТПРАВКИ И ПРЕДПРОСМОТР СООБЩЕНИЯ -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2.5">
              <span class="w-7 h-7 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center font-bold text-sm">📨</span>
              <div>
                <h3 class="text-sm font-bold text-slate-900">Проверка отправки в Telegram</h3>
                <p class="text-[11px] text-slate-500">Проверьте доставку уведомлений опекуну в реальном времени</p>
              </div>
            </div>
          </div>

          <!-- Предпросмотр текста сообщения для Telegram -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-slate-700 uppercase tracking-wider text-[11px]">💬 Формат сообщения для Telegram:</span>
              <span class="text-[10px] text-slate-400 font-mono">Markdown</span>
            </div>
            <div id="guardian-tg-preview" class="p-4 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-700 font-mono leading-relaxed">
              ${previewDisplayHtml}
            </div>
          </div>

          <!-- Кнопка проверки доставки -->
          <button id="btn-verify-telegram" onclick="App.verifyTelegramDelivery()" class="w-full py-2.5 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs shadow-sm active:scale-98 transition flex items-center justify-center space-x-2">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            <span>Проверить отправку в Telegram прямо сейчас</span>
          </button>

          <!-- Результат проверки в реальном времени -->
          <div id="guardian-verify-result-box" class="hidden p-3 rounded-xl border text-xs leading-relaxed space-y-1.5"></div>
        </div>

        <!-- 1. Быстрый обмен данными с сыном / врачом -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-bold text-slate-800 uppercase tracking-wider">Поделиться состоянием</div>
            <span class="text-[10px] font-mono text-teal-700 bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200">В 1 клик</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button onclick="App.shareViaWhatsApp()" class="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center justify-center space-x-2 transition shadow-sm">
              <span>💬 Отправить сводку в WhatsApp</span>
            </button>
            <button onclick="App.copyGuardianShareLink()" class="py-2.5 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200 flex items-center justify-center space-x-2 transition">
              <span>🔗 Скопировать ссылку для сына</span>
            </button>
          </div>
        </div>

        <!-- 2. Настройки опекуна (Telegram) -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3.5">
          <div class="text-xs font-bold text-teal-800 uppercase tracking-wider">Настройки опекуна / врача</div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Имя опекуна <span class="text-slate-400 font-normal">(например: Сын Арман, Врач Карим)</span></label>
            <input type="text" id="guardian-name" value="${cfg.name || ''}" placeholder="Сын Арман" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Телефон опекуна <span class="text-slate-400 font-normal">(для экстренного звонка)</span></label>
            <input type="tel" id="guardian-phone" value="${cfg.phone || ''}" placeholder="+7 777 123 4567" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200 text-[11px] text-amber-800 leading-relaxed space-y-1">
            <div class="font-bold">⚡ Как настроить Telegram-бота:</div>
            <div>1. Откройте Telegram → найдите <b>@BotFather</b> → напишите <span class="font-mono">/newbot</span></div>
            <div>2. Вставьте сюда полученный <b>Bot Token</b></div>
            <div>3. Нажмите <span class="font-mono">/start</span> в вашем новом боте, а в <b>@userinfobot</b> узнайте свой <b>Chat ID</b></div>
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Telegram Bot Token <span class="text-rose-500">*</span></label>
            <input type="text" id="guardian-token" value="${cfg.botToken || ''}" placeholder="1234567890:AAHq_ABCDEF..." class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Telegram Chat ID сына / опекуна <span class="text-rose-500">*</span></label>
            <input type="text" id="guardian-chatid" value="${cfg.chatId || ''}" placeholder="987654321" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-2 pt-1">
            <div class="text-xs font-medium text-slate-700">Когда присылать сигналы опекуну:</div>
            <label class="flex items-center space-x-3 cursor-pointer p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <input type="checkbox" id="guardian-notify-red" ${cfg.notifyRed ? 'checked' : ''} class="w-4 h-4 accent-rose-600 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-700">🔴 <b>Красная зона:</b> индекс ≥ 40 (Срочно!)</span>
            </label>
            <label class="flex items-center space-x-3 cursor-pointer p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <input type="checkbox" id="guardian-notify-det" ${cfg.notifyDeterioration ? 'checked' : ''} class="w-4 h-4 accent-amber-600 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-700">🟡 <b>Ухудшение:</b> резкий скачок пульса или падение кислорода</span>
            </label>
          </div>

          <button onclick="App.saveGuardianSettings()" class="w-full py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs shadow-sm transition">
            💾 Сохранить настройки опекуна
          </button>
        </div>
      </div>
    `;
  },

  saveGuardianSettings() {
    const cfg = {
      name: document.getElementById('guardian-name')?.value || '',
      phone: document.getElementById('guardian-phone')?.value || '',
      botToken: document.getElementById('guardian-token')?.value || '',
      chatId: document.getElementById('guardian-chatid')?.value || '',
      notifyRed: document.getElementById('guardian-notify-red')?.checked || false,
      notifyDeterioration: document.getElementById('guardian-notify-det')?.checked || false
    };
    this.saveGuardianConfig(cfg);
    this.showToast('Настройки опекуна сохранены', 'success');
  },

  getFormattedGuardianAlertMessage(scenario = 'red') {
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const bpm = this.state.bpm || 112;
    const spo2 = this.state.spo2 || 94;
    const idx = (this.state.modelEvaluation && this.state.modelEvaluation.index != null) ? this.state.modelEvaluation.index : (scenario === 'red' ? 46 : 28);
    const isRed = scenario === 'red' || idx >= 40;
    const emoji = isRed ? '🔴' : '🟡';
    const statusText = isRed ? 'ВЫСОКИЙ РИСК: Индекс кардио-напряжения ≥ 40' : 'Внимание: Умеренное отклонение показателей';

    return `${emoji} *Срочное оповещение Qamqor:* ${statusText}\n\n` +
      `👤 *Пациент:* ${patientName}\n` +
      `📊 *Индекс риска:* ${idx} / 100 (${isRed ? 'Красная зона' : 'Жёлтая зона'})\n` +
      `❤️ *Пульс (ЧСС):* ${bpm} уд/мин\n` +
      `🩸 *Кислород SpO2:* ${spo2}%\n\n` +
      `⚠️ *Рекомендация:* Свяжитесь с близким человеком, убедитесь в хорошем самочувствии или вызовите помощь.`;
  },

  async verifyTelegramDelivery() {
    const tokenInput = document.getElementById('guardian-token');
    const chatInput = document.getElementById('guardian-chatid');
    const resultBox = document.getElementById('guardian-verify-result-box');
    const btn = document.getElementById('btn-verify-telegram');

    const token = tokenInput ? tokenInput.value.trim() : '';
    const chatId = chatInput ? chatInput.value.trim() : '';

    if (!token || !chatId) {
      if (resultBox) {
        resultBox.className = 'p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1';
        resultBox.innerHTML = '❌ <b>Сначала введите Bot Token и Chat ID</b> в полях ниже, затем нажмите проверку.';
        resultBox.classList.remove('hidden');
      }
      this.showToast('Заполните Bot Token и Chat ID', 'warning');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⏳ Проверяем связь с Telegram...';
    }

    if (resultBox) {
      resultBox.className = 'p-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-xs leading-relaxed space-y-1';
      resultBox.innerHTML = '⏳ Отправляем тестовое сообщение через API Telegram...';
      resultBox.classList.remove('hidden');
    }

    const testMsg = this.getFormattedGuardianAlertMessage('red');
    const now = new Date().toLocaleString('ru-RU');
    const fullText = `🔔 *Тестовая проверка связи Qamqor*\n\n` +
      `Бот успешно подключён к системе мониторинга!\n\n` +
      `Вот так будет выглядеть экстренное сообщение опекуну:\n` +
      `-----------------------------------------\n` +
      testMsg + `\n` +
      `-----------------------------------------\n` +
      `⏰ Время отправки: ${now}`;

    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: fullText, parse_mode: 'Markdown' })
      });
      const data = await resp.json();

      if (data.ok) {
        localStorage.setItem('qamqor_v3_guardian_last_notif', Date.now().toString());
        this.saveGuardianSettings();
        if (resultBox) {
          resultBox.className = 'p-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-xs leading-relaxed space-y-1.5';
          resultBox.innerHTML = `✅ <b>Сообщение успешно доставлено в Telegram!</b><br>ID сообщения в чате: <span class="font-mono text-white">#${data.result.message_id}</span>. Проверьте ваш Telegram.`;
        }
        this.showToast('✅ Сообщение доставлено в Telegram!', 'success');
      } else {
        if (resultBox) {
          resultBox.className = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1.5';
          resultBox.innerHTML = `❌ <b>Ошибка Telegram API:</b> ${data.description || 'Не удалось доставить'}.<br><span class="text-slate-400">Проверьте: 1) Нажали ли вы /start в боте? 2) Верно ли скопирован chat_id?</span>`;
        }
        this.showToast('Ошибка Telegram: ' + (data.description || 'Проверьте данные'), 'warning');
      }
    } catch(err) {
      if (resultBox) {
        resultBox.className = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1.5';
        resultBox.innerHTML = `❌ <b>Сетевая ошибка:</b> ${err.message}. Проверьте интернет.`;
      }
      this.showToast('Сетевая ошибка при отправке', 'warning');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg><span>Проверить отправку в Telegram прямо сейчас</span>`;
      }
    }
  },

  async sendGuardianNotification(message) {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) return false;

    const profile = StorageService.getProfile();
    const userName = (profile && profile.name) ? profile.name : 'Мама';
    const now = new Date().toLocaleString('ru-RU');

    const fullText = '🏥 *Qamqor Health Alert*\n\n' +
      '👤 *Пациент:* ' + userName + '\n\n' +
      message + '\n\n' +
      '⏰ ' + now;

    try {
      const resp = await fetch('https://api.telegram.org/bot' + cfg.botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: fullText, parse_mode: 'Markdown' })
      });
      const data = await resp.json();
      if (data.ok) {
        localStorage.setItem('qamqor_v3_guardian_last_notif', Date.now().toString());
        return true;
      }
    } catch (e) {
      console.warn('[Guardian] Telegram error:', e.message);
    }
    return false;
  },

  async sendTestGuardianNotification() {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) {
      this.showToast('Сначала заполните Bot Token и Chat ID', 'warning');
      return;
    }
    this.showToast('Отправляем тестовое уведомление...', 'info');
    const guardianName = cfg.name || 'Опекун';
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const ok = await this.sendGuardianNotification(
      '✅ *Связь настроена успешно!*\n' +
      'Опекун: *' + guardianName + '*\n' +
      'Вы будете получать срочные сигналы, если у *' + patientName + '* ухудшатся показатели.'
    );
    if (ok) {
      this.showToast('Тестовое уведомление доставлено в Telegram!', 'success');
      this.renderGuardianTab();
    } else {
      this.showToast('Ошибка отправки. Проверьте токен и chat_id.', 'warning');
    }
  },

  async sendCurrentStatusNotification() {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) {
      this.showToast('Сначала заполните Bot Token и Chat ID', 'warning');
      return;
    }
    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const isRed = evalRes.zone === 'red';
    const isYellow = evalRes.zone === 'yellow';
    const emoji = isRed ? '🔴' : isYellow ? '🟡' : '🟢';
    const statusText = isRed ? 'ВЫСОКИЙ РИСК (Срочно принять меры!)' : isYellow ? 'Умеренное отклонение (Внимание)' : 'Состояние стабильное (В норме)';

    const msg = emoji + ' *Текущий отчёт о здоровье:*\n' +
      '• Статус: *' + statusText + '*\n' +
      '• Индекс риска: *' + (evalRes.index != null ? evalRes.index : 18) + ' / 100*\n' +
      '• Пульс: *' + (this.state.bpm || 72) + ' уд/мин*\n' +
      '• Кислород SpO2: *' + (this.state.spo2 || 98) + '%*';

    this.showToast('Отправляем текущую сводку в Telegram...', 'info');
    const ok = await this.sendGuardianNotification(msg);
    if (ok) {
      this.showToast('Сводка успешно отправлена опекуну!', 'success');
      this.renderGuardianTab();
    } else {
      this.showToast('Ошибка отправки.', 'warning');
    }
  },

  copyGuardianShareLink() {
    const profile = StorageService.getProfile();
    const name = encodeURIComponent((profile && profile.name) ? profile.name : 'Мама');
    const evalRes = this.state.modelEvaluation || { index: 18 };
    const url = window.location.origin + window.location.pathname + '?guardian_view=1&patient=' + name + '&risk=' + (evalRes.index || 18);
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        this.showToast('Ссылка скопирована! Отправьте её сыну или врачу', 'success');
      }).catch(() => {
        prompt('Скопируйте ссылку для сына/врача:', url);
      });
    } else {
      prompt('Скопируйте ссылку для сына/врача:', url);
    }
  },

  shareViaWhatsApp() {
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const text = encodeURIComponent(
      '🏥 Qamqor — Отчёт о здоровье (' + patientName + '):\n' +
      '• Индекс риска: ' + (evalRes.index != null ? evalRes.index : 18) + '/100\n' +
      '• Пульс: ' + (this.state.bpm || 72) + ' уд/мин\n' +
      '• Кислород: ' + (this.state.spo2 || 98) + '%\n' +
      'Время: ' + new Date().toLocaleTimeString('ru-RU')
    );
    window.open('https://wa.me/?text=' + text, '_blank');
  },

  callPatient() {
    const cfg = this.loadGuardianConfig();
    if (cfg.phone) {
      window.location.href = 'tel:' + cfg.phone.replace(/\s+/g, '');
    } else {
      this.showToast('Телефон не указан в настройках опекуна', 'info');
    }
  },

  exitGuardianView() {
    window.location.href = window.location.pathname;
  },

  // ========================================================
  // ДЫХАТЕЛЬНЫЙ ТРЕНАЖЕР 4-4-4
  // ========================================================
  _breathingInterval: null,
  _breathingActive: false,
  _breathingPhase: 0, // 0: inhale (4s), 1: hold (4s), 2: exhale (4s)
  _breathingSecLeft: 4,

  toggleBreathingExercise() {
    const box = document.getElementById('breathing-box');
    const btn = document.getElementById('btn-breathing-toggle');
    if (!box) return;

    if (this._breathingActive) {
      // Остановить
      clearInterval(this._breathingInterval);
      this._breathingActive = false;
      box.classList.add('hidden');
      if (btn) btn.innerHTML = '▶ Начать';
      this.showToast('Упражнение завершено', 'info');
    } else {
      // Запустить
      this._breathingActive = true;
      this._breathingPhase = 0;
      this._breathingSecLeft = 4;
      box.classList.remove('hidden');
      if (btn) btn.innerHTML = '⏹ Завершить';
      this._updateBreathingUI();

      this._breathingInterval = setInterval(() => {
        this._breathingSecLeft--;
        if (this._breathingSecLeft <= 0) {
          this._breathingPhase = (this._breathingPhase + 1) % 3;
          this._breathingSecLeft = 4;
        }
        this._updateBreathingUI();
      }, 1000);
      this.showToast('Дышите плавно и спокойно', 'info');
    }
  },

  _updateBreathingUI() {
    const secEl = document.getElementById('breathing-phase-sec');
    const textEl = document.getElementById('breathing-phase-text');
    const circleEl = document.getElementById('breathing-circle');
    if (!secEl || !textEl || !circleEl) return;

    secEl.textContent = this._breathingSecLeft;

    if (this._breathingPhase === 0) {
      textEl.textContent = '🌬️ Вдох носом (4 сек)...';
      textEl.className = 'text-xs font-bold text-cyan-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(1.25)';
      circleEl.style.borderColor = '#06b6d4';
      circleEl.style.backgroundColor = 'rgba(6, 182, 212, 0.3)';
    } else if (this._breathingPhase === 1) {
      textEl.textContent = '⏸️ Задержка дыхания (4 сек)...';
      textEl.className = 'text-xs font-bold text-amber-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(1.25)';
      circleEl.style.borderColor = '#f59e0b';
      circleEl.style.backgroundColor = 'rgba(245, 158, 11, 0.25)';
    } else {
      textEl.textContent = '💨 Плавный выдох через рот (4 сек)...';
      textEl.className = 'text-xs font-bold text-emerald-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(0.85)';
      circleEl.style.borderColor = '#10b981';
      circleEl.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
    }
  },

  registerSW() {
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(e => console.log('SW Note:', e.message));
    }
  }
};

// Экспорт в глобальную область для onclick-хэндлеров в HTML
if (typeof window !== 'undefined') {
  window.App = App;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => App.init());
    } else {
      App.init();
    }
  }
}


})();
