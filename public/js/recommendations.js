/**
 * Qamqor Health Monitoring System
 * Модуль персональных рекомендаций (Recommendation Engine)
 * Реализация спецификации разделов 4, 5, 6 обязательного модуля
 */

import { MODEL_CONFIG } from './config.js';

export const RecommendationCategory = {
  RETRY: 'повторное измерение',
  SPECIALIST: 'консультация специалиста',
  STRESS: 'стресс',
  SLEEP: 'сон',
  ACTIVITY: 'физическая активность',
  HYDRATION: 'гидратация'
};

export const Priority = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

/**
 * Класс RecommendationEngine
 * Генерирует клинически безопасные, персонализированные рекомендации
 * на основании доступных и валидных физиологических и анкетных показателей.
 */
export class RecommendationEngine {
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
