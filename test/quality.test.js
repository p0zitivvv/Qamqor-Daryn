/**
 * Модульные тесты контроля качества данных Qamqor
 * Проверка требований раздела 16.4 спецификации
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDataQuality,
  calculateBaselineCompleteness,
  calculateOverallCompleteness
} from '../js/quality.js';

test('16.4.1 Корректность расчета c_q как среднего по 4 компонентам', () => {
  const baselineReady = { isReady: true, sigmaHrv: 0.35 };

  // 1. Все 4 компонента идеальны (HR=72, SDNN=45, SpO2=98, p_irr=0.05) -> c_q = 1.0
  const qFull = calculateDataQuality({ hr: 72, sdnn: 45, spo2: 98, pIrr: 0.05 }, baselineReady);
  assert.equal(qFull.c_q, 1.0);
  assert.equal(qFull.statuses.hr.valid, true);
  assert.equal(qFull.statuses.hrv.valid, true);
  assert.equal(qFull.statuses.spo2.valid, true);
  assert.equal(qFull.statuses.arr.valid, true);

  // 2. Только пульс и SpO2 валидны (2 из 4) -> c_q = (1 + 0 + 1 + 0) / 4 = 0.50
  const qPartial = calculateDataQuality({ hr: 72, sdnn: null, spo2: 98, pIrr: null }, baselineReady);
  assert.equal(qPartial.c_q, 0.50);
  assert.equal(qPartial.statuses.hrv.valid, false);
  assert.equal(qPartial.statuses.arr.valid, false);

  // 3. Отсутствие данных -> c_q = 0.0
  const qEmpty = calculateDataQuality(null, null);
  assert.equal(qEmpty.c_q, 0.0);
});

test('16.4.2 Корректность расчета полноты базовой линии c_base = min(1, days / 7)', () => {
  assert.equal(calculateBaselineCompleteness(0), 0.0);
  assert.ok(Math.abs(calculateBaselineCompleteness(3.5) - 0.5) < 0.001);
  assert.equal(calculateBaselineCompleteness(7.0), 1.0);
  assert.equal(calculateBaselineCompleteness(14.0), 1.0, 'При >7 дней значение должно быть ограничено 1.0');
});

test('16.4.3 Итоговый коэффициент c = c_q * c_base и порог c < 0.5', () => {
  // c_q = 0.8, c_base = 0.7 -> c = 0.56 (>= 0.5 -> достаточно)
  const resSufficient = calculateOverallCompleteness(0.8, 0.7);
  assert.equal(resSufficient.c, 0.56);
  assert.equal(resSufficient.isSufficient, true);
  assert.equal(resSufficient.percentage, 56);

  // c_q = 1.0, но только 3 дня сбора (c_base = 3/7 ≈ 0.428) -> c ≈ 0.428 (< 0.5 -> Недостаточно данных)
  const resLowBase = calculateOverallCompleteness(1.0, 3 / 7);
  assert.ok(resLowBase.c < 0.5);
  assert.equal(resLowBase.isSufficient, false);
  assert.equal(resLowBase.label, 'Недостаточно данных для расчета');
});
