/**
 * Qamqor Health Monitoring System
 * Централизованная конфигурация математической модели и алгоритмов
 * Версия модели: 1.0.0-experimental
 */

export const MODEL_CONFIG = {
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
