/**
 * Qamqor Health Monitoring System
 * Unit Tests for Qamqor AI Advisor & Knowledge Base (15 test scenarios)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeBaseService, KNOWLEDGE_RULES, KnowledgeCategory, EvidenceLevel } from '../js/knowledge_base.js';
import { AIAdvisorService } from '../js/ai_advisor.js';
import { generateDeterministicInsight } from '../api/advisor.js';

// Сценарий 1: Валидация входных данных
test('1. Валидация входных данных: корректные типы и границы', () => {
  const service = new AIAdvisorService();
  const history = [
    { timestamp: Date.now() - 1000, bpm: 75, spo2: 98 },
    { timestamp: Date.now() - 2000, bpm: 80, spo2: 97 }
  ];
  const stats = service.extractTrendStats(history, { hr: 75, spo2: 98 }, { hr0: 70 });
  assert.equal(stats.count, 2);
  assert.equal(typeof stats.avgHr, 'number');
  assert.equal(typeof stats.avgSpo2, 'number');
  assert.equal(stats.hrDelta, 5);
});

// Сценарий 2: Неполные данные: работа при отсутствии отдельных метрик
test('2. Неполные данные: работа при отсутствии отдельных метрик', () => {
  const context = {
    metrics: {}, // нет пульса, нет SpO2
    baseline: { hr0: 70 },
    profile: { age: 35 },
    symptoms: {},
    isDemo: false
  };
  const insight = generateDeterministicInsight(context);
  assert.ok(insight.ai_insight);
  assert.ok(Array.isArray(insight.recommendations));
  assert.equal(insight.trend_summary.hr_delta, 0);
});

// Сценарий 3: Недостаточное качество данных (c < 0.5)
test('3. Недостаточное качество данных: безопасный результат', () => {
  const context = {
    metrics: { hr: 120, spo2: 80 },
    baseline: { hr0: 70 },
    quality: { c: 0.3 },
    profile: {},
    symptoms: {}
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  assert.ok(Array.isArray(rules));
});

// Сценарий 4: Красный флаг (Правило 10): боль в груди / одышка -> экстренная помощь
test('4. Красный флаг (Правило 10): боль в груди или одышка вызывает только экстренную помощь', () => {
  const context = {
    metrics: { hr: 72, spo2: 98 },
    baseline: { hr0: 70 },
    symptoms: { chestPain: true },
    profile: { activity: 0 }
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'rule_emergency_red_flag');
  assert.equal(rules[0].category, KnowledgeCategory.EMERGENCY);
  assert.ok(rules[0].action.includes('103'));
});

// Сценарий 5: Тахикардия в покое: совет на снижение пульса
test('5. Тахикардия в покое: формируется совет на диафрагмальное дыхание и паузу от кофеина', () => {
  const context = {
    metrics: { hr: 105, spo2: 98, sdnn: 40 },
    baseline: { hr0: 70 },
    symptoms: {},
    profile: { stress: 1 }
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  const tachyRule = rules.find(r => r.id === 'rule_elevated_resting_hr');
  assert.ok(tachyRule, 'Должно сработать правило повышенного пульса');
  assert.equal(tachyRule.category, KnowledgeCategory.STRESS);
  assert.ok(tachyRule.action.includes('4-4-4') || tachyRule.action.includes('диафрагмального'));
});

// Сценарий 6: Снижение SDNN: совет по сну и отдыху (без слова «диагноз»)
test('6. Снижение SDNN: рекомендуется сон и отдых, без диагнозов', () => {
  const context = {
    metrics: { hr: 72, spo2: 98, sdnn: 22 },
    baseline: { hr0: 70 },
    symptoms: {},
    profile: {}
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  const sleepRule = rules.find(r => r.id === 'rule_reduced_hrv_recovery');
  assert.ok(sleepRule, 'Должно сработать правило восстановления HRV');
  assert.equal(sleepRule.category, KnowledgeCategory.SLEEP);
  assert.ok(!sleepRule.action.toLowerCase().includes('диагноз'));
  assert.ok(sleepRule.why.clinicalRationale.includes('не болезнь'));
});

// Сценарий 7: Умеренное снижение SpO2 (90-94%)
test('7. Умеренное снижение SpO2 (90-94%): рекомендация по осанке и вентиляции', () => {
  const context = {
    metrics: { hr: 75, spo2: 93, sdnn: 45 },
    baseline: { hr0: 70 },
    symptoms: {},
    profile: {}
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  const spo2Rule = rules.find(r => r.id === 'rule_mild_hypoxia_posture');
  assert.ok(spo2Rule, 'Должно сработать правило умеренной гипоксии');
  assert.ok(spo2Rule.action.includes('осанк') || spo2Rule.action.includes('дыхание') || spo2Rule.action.includes('воздух'));
});

// Сценарий 8: Сидячий образ жизни: совет по физической активности
test('8. Сидячий образ жизни: рекомендация по ходьбе и стандарту ВОЗ', () => {
  const context = {
    metrics: { hr: 70, spo2: 98 },
    baseline: { hr0: 70 },
    profile: { activity: 0 },
    symptoms: {}
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  const actRule = rules.find(r => r.id === 'rule_sedentary_activity_boost');
  assert.ok(actRule, 'Должно сработать правило активности ВОЗ');
  assert.ok(actRule.evidenceSource.includes('WHO') || actRule.evidenceSource.includes('ВОЗ'));
});

// Сценарий 9: Несовместимые рекомендации: красный флаг исключает тренировки
test('9. Несовместимые рекомендации: при симптомах боли в груди физическая активность исключена', () => {
  const context = {
    metrics: { hr: 90, spo2: 97 },
    baseline: { hr0: 70 },
    profile: { activity: 0 },
    symptoms: { chestPain: true }
  };
  const rules = KnowledgeBaseService.evaluateRules(context);
  const hasActivity = rules.some(r => r.category === KnowledgeCategory.ACTIVITY);
  assert.equal(hasActivity, false, 'Активность категорически запрещена при красном флаге');
});

// Сценарий 10: Дебаунс: блокировка повторного вызова ранее 5 секунд
test('10. Дебаунс: блокировка повторного вызова ранее 5 секунд', () => {
  const service = new AIAdvisorService();
  service.lastAnalysisTime = Date.now();
  assert.equal(service.canRefresh(), false);
  assert.ok(service.getCooldownSeconds() > 0);

  service.lastAnalysisTime = Date.now() - 6000;
  assert.equal(service.canRefresh(), true);
  assert.equal(service.getCooldownSeconds(), 0);
});

// Сценарий 11: Структура ответа API: валидация схемы JSON
test('11. Структура ответа API: валидация схемы JSON', () => {
  const res = generateDeterministicInsight({
    metrics: { hr: 80, spo2: 97, sdnn: 40 },
    baseline: { hr0: 70 },
    historyStats: { count: 5, avgHr: 75 },
    profile: { age: 30 },
    rules: [],
    symptoms: {},
    isDemo: false
  });

  assert.ok(res.ai_insight);
  assert.ok(typeof res.ai_insight.summary === 'string');
  assert.ok(typeof res.ai_insight.trend_label === 'string');
  assert.ok(Array.isArray(res.recommendations));
  assert.ok(res.trend_summary);
  assert.ok(typeof res.trend_summary.hr_delta === 'number');
  assert.ok(typeof res.medical_disclaimer === 'string');
});

// Сценарий 12: Fallback при сетевой ошибке: генерация локальных рекомендаций
test('12. Fallback при сетевой ошибке: генерация локальных рекомендаций', async () => {
  const service = new AIAdvisorService();
  // Вызов локального синтеза при недоступности сети
  const insight = service.synthesizeLocalInsight({
    metrics: { hr: 76, spo2: 98 },
    baseline: { hr0: 70 },
    rules: [KNOWLEDGE_RULES[1]],
    symptoms: {}
  });

  assert.ok(insight.ai_insight.summary.length > 0);
  assert.equal(insight.recommendations.length, 1);
  assert.equal(insight.recommendations[0].id, KNOWLEDGE_RULES[1].id);
});

// Сценарий 13: Демо-режим vs Реальный режим: корректность метки
test('13. Демо-режим vs Реальный режим: корректность метки источника', () => {
  const demoRes = generateDeterministicInsight({ metrics: {}, baseline: {}, rules: [], symptoms: {}, isDemo: true });
  const realRes = generateDeterministicInsight({ metrics: {}, baseline: {}, rules: [], symptoms: {}, isDemo: false });
  assert.equal(demoRes.isDemo, true);
  assert.equal(realRes.isDemo, false);
});

// Сценарий 14: Сохранение выполненных действий: отметка пользователем
test('14. Сохранение выполненных действий: отметка пользователем', () => {
  const service = new AIAdvisorService();
  service.toggleActionCompleted('test_action_1');
  assert.ok(service.completedActionIds.has('test_action_1'));

  service.toggleActionCompleted('test_action_1');
  assert.equal(service.completedActionIds.has('test_action_1'), false);
});

// Сценарий 15: Формирование обоснования «Почему этот совет?»: наличие всех 5 полей
test('15. Формирование обоснования «Почему этот совет?»: наличие ключевых полей', () => {
  const rule = KNOWLEDGE_RULES[1]; // Elevated resting HR
  const why = rule.getWhyExplanation({
    metrics: { hr: 96 },
    baseline: { hr0: 72 }
  });

  assert.ok(why.triggerMetric, 'Должен быть триггер');
  assert.ok(why.baselineComparison, 'Должно быть сравнение с базовой нормой');
  assert.ok(why.timeframe, 'Должен быть временной горизонт');
  assert.ok(why.clinicalRationale, 'Должно быть клиническое обоснование');
  assert.ok(why.limitations, 'Должны быть ограничения/дисклеймер');
});
