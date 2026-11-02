/**
 * Qamqor Health Monitoring System
 * Модуль математической модели (Model Engine)
 * Реализация спецификации раздела 3-5, 8, 10
 */

import { MODEL_CONFIG } from './config.js';

/**
 * Численно устойчивая логистическая сигмоида
 * r*(t) = 1 / (1 + e^(-L))
 * Предотвращает переполнение при экстремальных значениях L
 * @param {number} L - Значение логита
 * @returns {number} Вероятность r* в интервале (0, 1)
 */
export function logistic(L) {
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
export function clip(val, min, max) {
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
export function calculateBMI(weightKg, heightM) {
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
export function normalizeAge(age) {
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
export function normalizeBMI(bmi) {
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
export function calculateLStat(survey) {
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
export function validateSurvey(survey) {
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
export function calculateSpO2Score(spo2) {
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
export function calculateLDyn(metrics, baseline) {
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
export function smoothRisk(rPrev, rTarget, dtMinutes = 1, tauMinutes = 5) {
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
export function evaluateModel({ lStat, lDyn, c, rPrev = null, dtMinutes = 1 }) {
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
