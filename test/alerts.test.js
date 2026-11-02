/**
 * Модульные тесты машины состояний тревог Qamqor (Alert Engine)
 * Проверка требований раздела 16.6 спецификации
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, AlertState } from '../js/alerts.js';

test('16.6.1 Индекс ниже 40 не запускает тревогу', () => {
  const engine = new AlertEngine();
  // 10 минут подряд при индексе 38 (желтая зона) и качестве 1.0
  for (let m = 0; m < 10; m++) {
    const res = engine.update({ index: 38, c: 1.0 });
    assert.equal(res.shouldAlert, false);
    assert.notEqual(res.state, AlertState.TRIGGERED);
  }
});

test('16.6.2 Требуется ровно 5 последовательных минут превышения I >= 40', () => {
  const engine = new AlertEngine();

  // Минуты 1-4: PENDING, тревога еще не срабатывает
  for (let m = 1; m <= 4; m++) {
    const res = engine.update({ index: 45, c: 1.0 });
    assert.equal(res.shouldAlert, false, `На минуте ${m} тревога не должна сработать`);
    assert.equal(res.state, AlertState.PENDING);
    assert.equal(res.consecutiveMinutes, m);
  }

  // Минута 5: ровно 5 минут -> СРАБАТЫВАНИЕ!
  const res5 = engine.update({ index: 45, c: 1.0 });
  assert.equal(res5.shouldAlert, true, 'На 5-й минуте тревога обязана сработать');
  assert.equal(res5.state, AlertState.TRIGGERED);
  assert.ok(res5.alertMessage.includes('Индекс Qamqor находится в красной зоне'));
});

test('16.6.3 Прерывание кратковременного всплеска сбрасывает счетчик минут', () => {
  const engine = new AlertEngine();

  // 3 минуты превышения
  engine.update({ index: 45, c: 1.0 });
  engine.update({ index: 45, c: 1.0 });
  const res3 = engine.update({ index: 45, c: 1.0 });
  assert.equal(res3.consecutiveMinutes, 3);

  // На 4-й минуте индекс упал до 35
  const resDrop = engine.update({ index: 35, c: 1.0 });
  assert.equal(resDrop.consecutiveMinutes, 0, 'Счетчик должен сброситься');
  assert.equal(resDrop.shouldAlert, false);

  // Снова подъем до 45 — отсчет начинается заново с 1
  const resNew = engine.update({ index: 45, c: 1.0 });
  assert.equal(resNew.consecutiveMinutes, 1);
  assert.equal(resNew.shouldAlert, false);
});

test('16.6.4 Блокировка тревоги при недостаточном качестве данных (c < 0.5)', () => {
  const engine = new AlertEngine();

  // Индекс в красной зоне (60), но качество c = 0.40 (< 0.5)
  for (let m = 0; m < 7; m++) {
    const res = engine.update({ index: 60, c: 0.40 });
    assert.equal(res.shouldAlert, false, 'При c < 0.5 тревога обязана быть заблокирована');
    assert.equal(res.state, AlertState.SUPPRESSED_POOR_QUALITY);
  }
});

test('16.6.5 Гистерезис: блокировка повторного срабатывания без возврата ниже 30', () => {
  const engine = new AlertEngine();

  // 1. Доводим до первой тревоги (5 минут I=45)
  for (let m = 0; m < 4; m++) engine.update({ index: 45, c: 1.0 });
  const triggerRes = engine.update({ index: 45, c: 1.0 });
  assert.equal(triggerRes.shouldAlert, true);

  // 2. На 6-й, 7-й минутах индекс остается 45 — тревога НЕ должна повторно спамить!
  const res6 = engine.update({ index: 45, c: 1.0 });
  assert.equal(res6.shouldAlert, false, 'Тревога не должна спамить повторно на каждом шаге');

  // 3. Индекс снизился до 35 (ниже 40, но ВЫШЕ порога гистерезиса 30)
  engine.update({ index: 35, c: 1.0 });

  // 4. Индекс снова вырос до 45 на 5 минут — БЕЗ возврата ниже 30 новая тревога НЕ взводится!
  for (let m = 0; m < 5; m++) {
    const res = engine.update({ index: 45, c: 1.0 });
    assert.equal(res.shouldAlert, false, 'Без снижения ниже 30 гистерезис блокирует повторную тревогу');
  }

  // 5. Теперь индекс наконец опустился ниже 30 (например, 22)
  engine.update({ index: 22, c: 1.0 });
  assert.equal(engine.wasBelowRecovery, true, 'Гистерезис восстановился');

  // 6. Теперь при новом подъеме до 45 на 5 минут тревога снова штатно сработает!
  for (let m = 0; m < 4; m++) engine.update({ index: 45, c: 1.0 });
  const secondTrigger = engine.update({ index: 45, c: 1.0 });
  assert.equal(secondTrigger.shouldAlert, true, 'После падения ниже 30 новая тревога успешно сработала');
});

test('16.6.6 Сохранение и восстановление состояния автомата (сериализация)', () => {
  const engine1 = new AlertEngine();
  engine1.update({ index: 45, c: 1.0 });
  engine1.update({ index: 45, c: 1.0 });
  engine1.update({ index: 45, c: 1.0 }); // 3 минуты

  const json = engine1.toJSON();

  const engine2 = new AlertEngine(json);
  assert.equal(engine2.consecutiveMinutes, 3);
  assert.equal(engine2.state, AlertState.PENDING);

  // Еще 2 минуты в восстановленном автомате -> срабатывание
  engine2.update({ index: 45, c: 1.0 });
  const res = engine2.update({ index: 45, c: 1.0 });
  assert.equal(res.shouldAlert, true);
});
