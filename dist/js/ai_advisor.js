/**
 * Qamqor Health Monitoring System
 * Layer 1 & 3: Qamqor AI Advisor Client Service
 * 
 * Analyzes trends, coordinates knowledge base rules, calls /api/advisor,
 * and provides mode-isolated caching and offline fallback.
 */

import { KnowledgeBaseService } from './knowledge_base.js';
import { StorageService } from './storage.js';

export class AIAdvisorService {
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
