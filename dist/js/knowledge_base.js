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

export const EvidenceLevel = {
  LEVEL_A: 'Уровень A (РКИ / мета-анализы)',
  LEVEL_B: 'Уровень B (Когортные исследования)',
  EXPERT: 'Консенсус экспертов (WHO/AHA/NHS)'
};

export const KnowledgeCategory = {
  SLEEP: 'sleep',
  ACTIVITY: 'activity',
  STRESS: 'stress',
  HEART: 'heart',
  LIFESTYLE: 'lifestyle',
  EMERGENCY: 'emergency'
};

export const CategoryLabels = {
  [KnowledgeCategory.SLEEP]: 'Сон и восстановление',
  [KnowledgeCategory.ACTIVITY]: 'Физическая активность',
  [KnowledgeCategory.STRESS]: 'Управление стрессом',
  [KnowledgeCategory.HEART]: 'Сердечно-сосудистый тонус',
  [KnowledgeCategory.LIFESTYLE]: 'Образ жизни и гидратация',
  [KnowledgeCategory.EMERGENCY]: 'Неотложная помощь'
};

export const KNOWLEDGE_RULES = [
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

export class KnowledgeBaseService {
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
