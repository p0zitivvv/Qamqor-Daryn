/**
 * Модульные тесты модуля персональных рекомендаций Qamqor
 * Проверка правил разделов 4, 5, 6 спецификации
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RecommendationEngine, RecommendationCategory, Priority } from '../js/recommendations.js';

test('4.1 Правило 10: Красные флаги (боль в груди/одышка) вызывают вызов помощи независимо от индекса', () => {
  const engine = new RecommendationEngine();

  // Индекс идеальный (зеленая зона, 12), но есть боль в груди
  const recs = engine.generateRecommendations({
    metrics: { hr: 70, sdnn: 50, spo2: 99 },
    baseline: { hr0: 70 },
    quality: { c: 1.0 },
    profile: { stress: 0, activity: 1 },
    symptoms: { chestPain: true, shortness: false },
    index: 12
  });

  assert.equal(recs.length, 1);
  assert.equal(recs[0].category, RecommendationCategory.SPECIALIST);
  assert.equal(recs[0].priority, Priority.HIGH);
  assert.ok(recs[0].action.includes('103'));
});

test('4.2 Правило 2: При низком качестве данных (c < 0.5) формируется совет проверить датчик', () => {
  const engine = new RecommendationEngine();

  // Качество данных c = 0.35 (< 0.5)
  const recs = engine.generateRecommendations({
    metrics: { hr: 95, sdnn: 20, spo2: 90 },
    quality: { c: 0.35 },
    profile: { stress: 1 },
    symptoms: {}
  });

  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, 'quality_sensor_contact');
  assert.equal(recs[0].category, RecommendationCategory.RETRY);
  assert.ok(recs[0].action.includes('плотно прилегает'));
});

test('4.3 Правило 3: Реакция на тахикардию и умеренное отклонение пульса', () => {
  const engine = new RecommendationEngine();

  // Пульс 108 уд/мин (норма 70)
  const recsTachy = engine.generateRecommendations({
    metrics: { hr: 108, spo2: 98, sdnn: 45 },
    baseline: { hr0: 70 },
    quality: { c: 0.9 },
    profile: { stress: 0, activity: 1 },
    symptoms: {}
  });

  const hrRec = recsTachy.find(r => r.metric === 'hr');
  assert.ok(hrRec, 'Должна быть рекомендация по ЧСС');
  assert.equal(hrRec.id, 'hr_tachycardia');
  assert.equal(hrRec.priority, Priority.HIGH);
  assert.ok(hrRec.action.includes('дыхательное упражнение'));
});

test('4.4 Правило 4: Снижение SDNN не объявляется болезнью, рекомендуется сон и отдых', () => {
  const engine = new RecommendationEngine();

  // SDNN = 20 мс при базовой норме 50 мс
  const recsHrv = engine.generateRecommendations({
    metrics: { hr: 72, spo2: 98, sdnn: 20 },
    baseline: { hr0: 70, lnSdnn0: Math.log(50), sigmaHrv: 0.3, isReady: true },
    quality: { c: 0.9 },
    profile: { stress: 0, activity: 1 },
    symptoms: {}
  });

  const hrvRec = recsHrv.find(r => r.metric === 'sdnn');
  assert.ok(hrvRec);
  assert.equal(hrvRec.category, RecommendationCategory.SLEEP);
  assert.ok(!hrvRec.description.includes('диагноз инфаркт'));
  assert.ok(hrvRec.description.includes('не диагноз'));
  assert.ok(hrvRec.action.includes('ночной сон'));
});

test('4.5 Формирование плана «Что можно улучшить» (не более 3 действий)', () => {
  const engine = new RecommendationEngine();

  const recs = [
    { id: 'act_1', title: 'Действие 1', action: 'Шаг 1', category: 'стресс', priority: Priority.LOW, triggerReason: 'R1' },
    { id: 'act_2', title: 'Действие 2', action: 'Шаг 2', category: 'сон', priority: Priority.HIGH, triggerReason: 'R2' },
    { id: 'act_3', title: 'Действие 3', action: 'Шаг 3', category: 'гидратация', priority: Priority.MEDIUM, triggerReason: 'R3' },
    { id: 'act_4', title: 'Действие 4', action: 'Шаг 4', category: 'активность', priority: Priority.LOW, triggerReason: 'R4' }
  ];

  const plan = engine.getImprovementPlan(recs, ['act_2']);

  assert.equal(plan.length, 3, 'План должен содержать не более 3 пунктов');
  assert.equal(plan[0].id, 'act_2', 'Сначала идет пункт с наивысшим приоритетом HIGH');
  assert.equal(plan[0].isCompleted, true, 'Статус выполнения должен сохраняться');
  assert.equal(plan[1].id, 'act_3', 'Второй пункт MEDIUM');
});
