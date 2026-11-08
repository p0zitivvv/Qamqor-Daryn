/**
 * Qamqor Health Monitoring System
 * Serverless API Endpoint: /api/advisor
 * Compatible with Vercel Serverless Functions and local Node.js server
 */

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
    return;
  }

  // Parse body
  let body = '';
  try {
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf-8');
      body = raw ? JSON.parse(raw) : {};
    }
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Invalid JSON payload in request body' }));
    return;
  }

  const {
    metrics = {},
    baseline = {},
    historyStats = {},
    profile = {},
    rules = [],
    symptoms = {},
    modelResult = {},
    isDemo = false
  } = body;

  const apiKey = process.env.GEMINI_API_KEY;

  try {
    let result = null;

    if (apiKey) {
      result = await callGeminiAdvisor({
        apiKey,
        metrics,
        baseline,
        historyStats,
        profile,
        rules,
        symptoms,
        modelResult,
        isDemo
      });
    }

    if (!result) {
      result = generateDeterministicInsight({
        metrics,
        baseline,
        historyStats,
        profile,
        rules,
        symptoms,
        modelResult,
        isDemo
      });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('Advisor error:', err);
    // Safe graceful fallback
    const fallback = generateDeterministicInsight({
      metrics,
      baseline,
      historyStats,
      profile,
      rules,
      symptoms,
      modelResult,
      isDemo
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(fallback));
  }
}

/**
 * Call Google Gemini LLM API with strict JSON schema
 */
async function callGeminiAdvisor(params) {
  const { apiKey, metrics, baseline, historyStats, profile, rules, symptoms, modelResult = {}, isDemo } = params;

  const prompt = `
Ты — Qamqor AI Advisor, клинически обоснованный персональный помощник по профилактике и мониторингу кардио-здоровья.
Твоя задача — проанализировать текущие физиологические показатели пользователя, сопоставить их с его базовой нормой, историей за 7 дней и отобранными правилами доказательной медицины (ВОЗ, AHA, NHS).
Сформируй понятное, эмпатичное резюме и практические рекомендации на русском языке.

СТРОГИЕ ПРАВИЛА БЕЗОПАСНОСТИ:
1. Запрещено ставить медицинские диагнозы (инфаркт, ИБС, гипертония и т.д.).
2. Запрещено назначать лекарства или медицинские препараты.
3. Если есть боль в груди, выраженная одышка или сатурация < 90% — немедленно укажи необходимость вызова скорой помощи (103/112) и запрети любые упражнения.
4. Отвечай строго в формате JSON, без markdown разметки вокруг (\`\`\`json ... \`\`\`).
5. Математическая модель отвечает за вычисление Risk Score. AI отвечает за интерпретацию. Запрещено придумывать или менять Risk Score!

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ:
- Режим: ${isDemo ? 'DEMO MODE (Демонстрационный режим, маркировка AI DEMO ANALYSIS)' : 'REAL DEVICE MODE (Реальное устройство ESP32, маркировка AI REAL DATA ANALYSIS)'}
- Индекс риска математической модели: ${modelResult.index != null ? modelResult.index + '/100 (' + (modelResult.zone || 'норма') + ')' : (isDemo ? '18/100 (демо)' : 'не рассчитан: недостаточно биометрических данных')}
- Пульс (ЧСС): ${metrics.hr != null ? metrics.hr + ' уд/мин' : (isDemo ? '72 уд/мин (демо)' : 'нет данных (датчик не активен)')}
- Базовый пульс в покое: ${baseline.hr0 || 70} уд/мин
- Кислород (SpO2): ${metrics.spo2 != null ? metrics.spo2 + '%' : (isDemo ? '98% (демо)' : 'нет данных')}
- Вариабельность ритма (SDNN): ${metrics.sdnn != null ? Math.round(metrics.sdnn) + ' мс' : (isDemo ? '48 мс (демо)' : 'нет данных')}
- Симптомы: боль в груди: ${symptoms.chestPain ? 'ДА' : 'нет'}, одышка: ${symptoms.shortness ? 'ДА' : 'нет'}
- Возраст: ${profile.age || 40}, ИМТ: ${profile.bmi || 24.5}, курение: ${profile.smoking ? 'да' : 'нет'}, стресс: ${profile.stress || 0}
- Статистика 7 дней: средний ЧСС ${historyStats.avgHr || '—'}, измерений: ${historyStats.count || 0}
- Предварительно отобранные правила доказательной базы:
${JSON.stringify(rules.map(r => ({ id: r.id, title: r.title, action: r.action, evidenceSource: r.evidenceSource, expectedBenefit: r.expectedBenefit })))}

ТРЕБУЕМАЯ СХЕМА JSON:
{
  "ai_insight": {
    "summary": "Краткое (2-3 предложения) эмпатичное и понятное резюме текущего состояния и динамики.",
    "trend_assessment": "improving" | "stable" | "needs_attention" | "warning",
    "trend_label": "Стабильно" | "Положительная динамика" | "Требует внимания" | "Внимание: обратитесь к врачу",
    "key_observation": "Ключевое наблюдение (например: 'Пульс на 12 уд/мин выше базового на фоне утомления')"
  },
  "recommendations": [
    {
      "id": "строковый ID",
      "category": "sleep" | "activity" | "stress" | "heart" | "lifestyle" | "emergency",
      "category_label": "Категория на русском",
      "priority": "high" | "medium" | "low",
      "title": "Краткий заголовок действия",
      "action": "Конкретный шаг, что делать прямо сейчас",
      "expected_benefit": "Ожидаемый физиологический эффект",
      "evidence_source": "Источник доказательной базы (ВОЗ, AHA, NHS)",
      "evidence_level": "Уровень A / B / Консенсус",
      "why": {
        "trigger_metric": "Какое именно значение вызвало этот совет",
        "baseline_comparison": "Сравнение с базовой нормой",
        "timeframe": "Период замера (текущий сеанс / 7 дней)",
        "clinical_rationale": "Клиническое объяснение простыми словами",
        "limitations": "Ограничения (не является диагнозом и т.д.)"
      }
    }
  ],
  "trend_summary": {
    "hr_delta": 0,
    "hrv_status": "normal",
    "spo2_stability": "high",
    "cardio_load_trend": "stable"
  },
  "medical_disclaimer": "Оценка носит исключительно информационно-профилактический характер и не заменяет консультацию врача."
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No candidate text returned by Gemini');

  const parsed = JSON.parse(text);
  return validateAdvisorPayload(parsed);
}

/**
 * Валидация структуры ответа от LLM
 */
function validateAdvisorPayload(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid payload');
  if (!obj.ai_insight || !Array.isArray(obj.recommendations)) {
    throw new Error('Payload missing ai_insight or recommendations');
  }
  return obj;
}

/**
 * Детерминированный генератор рекомендаций (Fallback & Offline)
 */
export function generateDeterministicInsight({ metrics = {}, baseline = {}, historyStats = {}, profile = {}, rules = [], symptoms = {}, modelResult = {}, isDemo = false }) {
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
  let keyObservation = 'Показатели в границах физиологического оптимума';

  if (isEmergency) {
    trendAssessment = 'warning';
    baseTrendLabel = 'Внимание: вызовите помощь';
    summary = 'Зафиксированы симптомы или показатели критической нагрузки. Немедленно прекратите физическую активность и обеспечьте покой.';
    keyObservation = 'Критический сигнал: требуется очная медицинская оценка (103/112)';
  } else if (hrDelta >= 15 || (spo2 != null && spo2 < 95)) {
    trendAssessment = 'needs_attention';
    baseTrendLabel = 'Требует внимания';
    summary = `Наблюдается умеренное увеличение напряжения регуляторных систем: пульс превышает базовый уровень на ${hrDelta > 0 ? '+' + hrDelta : hrDelta} уд/мин. Рекомендуется отдых и восстановление дыхания.`;
    keyObservation = `Пульс в покое повышен на ${hrDelta > 0 ? '+' + hrDelta : hrDelta} уд/мин относительно индивидуальной нормы (${hr0} уд/мин)`;
  } else if (hrDelta <= 5 && (spo2 == null || spo2 >= 96)) {
    trendAssessment = 'improving';
    baseTrendLabel = 'Положительная динамика';
    summary = 'Ритм и сатурация демонстрируют стабильную адаптацию к повседневным нагрузкам. Показатели восстановления на хорошем уровне.';
    keyObservation = 'Отличная синхронизация пульса с индивидуальной базовой нормой';
  }

  // Интеграция вывода математической модели
  if (modelResult && modelResult.index != null) {
    const zoneDesc = modelResult.zone === 'red' ? 'высокая нагрузка' : modelResult.zone === 'yellow' ? 'умеренное внимание' : 'норма';
    summary += ` Индекс кардио-риска модели: ${modelResult.index}/100 (${zoneDesc}).`;
  }

  const trendLabel = isDemo ? `AI DEMO: ${baseTrendLabel}` : `AI REAL: ${baseTrendLabel}`;

  // Map candidate rules to recommendation structure
  const formattedRecs = (rules && rules.length > 0) ? rules.map((r, i) => ({
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
    why: r.why || {
      triggerMetric: `Текущий показатель: ${hr != null ? hr + ' уд/мин' : 'плановый мониторинг'}`,
      baselineComparison: `Индивидуальная норма: ${hr0} уд/мин`,
      timeframe: 'Сеанс измерений',
      clinicalRationale: 'Снижение стрессовых воздействий способствует нормализации вегетативного баланса.',
      limitations: 'Не является диагнозом. При ухудшении самочувствия проконсультируйтесь с врачом.'
    }
  })) : [
    {
      id: 'rec_default_optimal',
      category: 'lifestyle',
      category_label: 'Образ жизни',
      priority: 'low',
      title: 'Поддержание текущего кардио-баланса',
      action: 'Сохраняйте комфортный темп дня, пейте достаточно чистой воды и сделайте вечернюю 20-минутную прогулку.',
      expected_benefit: 'Поддержание аэробной выносливости и глубокого сна',
      evidence_source: 'Рекомендации ВОЗ по физической активности (2020)',
      evidence_level: 'Консенсус экспертов ВОЗ',
      why: {
        triggerMetric: 'Показатели в пределах целевых диапазонов',
        baselineComparison: `Пульс ${hr || hr0} уд/мин при норме ${hr0} уд/мин`,
        timeframe: 'Текущий мониторинг',
        clinicalRationale: 'Умеренная регулярная активность поддерживает эластичность сосудистой стенки.',
        limitations: 'Ориентировочная оценка для здорового образа жизни.'
      }
    }
  ];

  return {
    ai_insight: {
      summary,
      trend_assessment: trendAssessment,
      trend_label: trendLabel,
      key_observation: keyObservation
    },
    recommendations: formattedRecs,
    trend_summary: {
      hr_delta: hrDelta,
      hrv_status: (sdnn && sdnn < 30) ? 'reduced' : (sdnn && sdnn > 80) ? 'elevated' : 'normal',
      spo2_stability: (spo2 && spo2 < 95) ? 'moderate' : 'high',
      cardio_load_trend: hrDelta > 10 ? 'increasing' : 'stable'
    },
    medical_disclaimer: 'Оценка носит исключительно информационно-профилактический характер и не заменяет консультацию врача.',
    isDemo: Boolean(isDemo)
  };
}
