/**
 * Модульные тесты обработки сигналов Qamqor
 * Проверка требований разделов 7 и 16.7 спецификации
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePulseOximetry,
  isValidRRInterval,
  calculateSDNN,
  calculateRMSSD,
  calculateRhythmIrregularity,
  checkECGSignalQuality,
  RPeakDetector
} from '../js/signals.js';

test('16.7.1 Валидация данных пульсоксиметра MAX30102', () => {
  // Валидные показатели: 72 уд/мин, 98%
  const valid = validatePulseOximetry(72, 98);
  assert.equal(valid.isValid, true);
  assert.equal(valid.bpm, 72);
  assert.equal(valid.spo2, 98);

  // Снятый палец (0 уд/мин, 0% SpO2)
  const fingerOff = validatePulseOximetry(0, 0);
  assert.equal(fingerOff.isValid, false);
  assert.ok(fingerOff.reason.includes('палец снят'));

  // Нефизиологичный пульс (20 уд/мин или 250 уд/мин)
  assert.equal(validatePulseOximetry(20, 98).isValid, false);
  assert.equal(validatePulseOximetry(250, 98).isValid, false);

  // SpO2 < 70% (артефакт или невалидный замер)
  assert.equal(validatePulseOximetry(72, 60).isValid, false);
});

test('16.7.2 Фильтрация интервалов RR в диапазоне [0.27, 2.0] секунд', () => {
  assert.equal(isValidRRInterval(0.80), true);  // 75 уд/мин -> валидно
  assert.equal(isValidRRInterval(0.27), true);  // Нижняя граница -> валидно
  assert.equal(isValidRRInterval(2.00), true);  // Верхняя граница -> валидно

  // Слишком короткие интервалы (шум / двойной триггер)
  assert.equal(isValidRRInterval(0.15), false);
  assert.equal(isValidRRInterval(0.26), false);

  // Слишком длинные интервалы (пропущенный пик / пауза)
  assert.equal(isValidRRInterval(2.01), false);
  assert.equal(isValidRRInterval(3.50), false);
  assert.equal(isValidRRInterval(NaN), false);
});

test('16.7.3 Расчет SDNN по валидным интервалам', () => {
  // 6 интервалов: [0.80, 0.82, 0.78, 0.81, 0.79, 0.83] с (в мс: 800, 820, 780, 810, 790, 830)
  // Среднее: 805 мс
  // Отклонения: -5, +15, -25, +5, -15, +25
  // Квадраты: 25, 225, 625, 25, 225, 625 -> сумма = 1750
  // Дисперсия: 1750 / (6 - 1) = 350
  // SDNN = sqrt(350) ≈ 18.708 мс
  const rr = [0.80, 0.82, 0.78, 0.81, 0.79, 0.83];
  const sdnn = calculateSDNN(rr);
  assert.ok(Math.abs(sdnn - 18.708) < 0.01);

  // Автоматическое отбрасывание артефактов (например, 0.10 с и 3.0 с)
  const rrWithArtifacts = [0.10, 0.80, 0.82, 3.00, 0.78, 0.81, 0.79, 0.83];
  const sdnnCleaned = calculateSDNN(rrWithArtifacts);
  assert.ok(Math.abs(sdnnCleaned - 18.708) < 0.01);

  // Менее 5 валидных интервалов -> null (недостаточно данных)
  assert.equal(calculateSDNN([0.80, 0.82, 0.85]), null);
});

test('16.7.4 Расчет RMSSD', () => {
  const rr = [0.80, 0.82, 0.78, 0.81, 0.79, 0.83]; // мс: 800, 820, 780, 810, 790, 830
  // Разности d: +20, -40, +30, -20, +40
  // Квадраты d^2: 400, 1600, 900, 400, 1600 -> сумма = 4900
  // RMSSD = sqrt(4900 / 5) = sqrt(980) ≈ 31.305 мс
  const rmssd = calculateRMSSD(rr);
  assert.ok(Math.abs(rmssd - 31.305) < 0.01);
});

test('16.7.5 Расчет показателя нерегулярности ритма p_irr с порогом 20%', () => {
  // Ритмичный пульс (все колебания < 20%):
  const regularRR = [0.80, 0.82, 0.81, 0.83, 0.80, 0.82];
  assert.equal(calculateRhythmIrregularity(regularRR), 0.0);

  // Нерегулярный ритм: из 5 переходов 2 превышают 20%:
  // 1. 0.80 -> 1.05 (разница 0.25 > 0.16) -> ДА (+1)
  // 2. 1.05 -> 1.08 (разница 0.03 < 0.21) -> нет
  // 3. 1.08 -> 0.70 (разница 0.38 > 0.216) -> ДА (+1)
  // 4. 0.70 -> 0.72 (разница 0.02 < 0.14) -> нет
  // 5. 0.72 -> 0.75 (разница 0.03 < 0.144) -> нет
  // Итого: 2 из 5 = 0.40
  const irrRR = [0.80, 1.05, 1.08, 0.70, 0.72, 0.75];
  const pIrr = calculateRhythmIrregularity(irrRR);
  assert.equal(pIrr, 0.40);
});

test('16.7.6 Контроль качества сигнала ЭКГ (AD8232): обрыв и клиппинг', () => {
  // Нормальный сигнал
  assert.equal(checkECGSignalQuality(2048, false).isValid, true);
  assert.equal(checkECGSignalQuality(2800, false).isValid, true);

  // Обрыв электродов (LO+ / LO-)
  const leadsOff = checkECGSignalQuality(2048, true);
  assert.equal(leadsOff.isValid, false);
  assert.equal(leadsOff.isLeadsOff, true);

  // Клиппинг (насыщение АЦП в 0 или 4095)
  assert.equal(checkECGSignalQuality(2, false).isClipped, true);
  assert.equal(checkECGSignalQuality(4093, false).isClipped, true);
});

test('16.7.7 Детектор R-пиков: рефрактерный период защищает от двойных пиков', () => {
  const detector = new RPeakDetector(25); // 25 Гц частота телеметрии
  let peakCount = 0;

  // Подаем острый R-пик на 10-м отсчете (амплитуда 3200)
  for (let i = 0; i < 9; i++) {
    detector.processSample(2048, i * 40);
  }
  const peak1 = detector.processSample(3200, 9 * 40);
  if (peak1) peakCount++;

  // Сразу следующий отсчет тоже высокий (шум спадающего зубца) — должен быть подавлен рефрактерным периодом!
  const duplicate = detector.processSample(3100, 10 * 40);
  assert.equal(duplicate, null, 'Рефрактерный период обязан блокировать дублирующий пик');

  // Через 800 мс (20 отсчетов) подаем следующий настоящий R-пик
  for (let i = 11; i < 29; i++) {
    detector.processSample(2048, i * 40);
  }
  const peak2 = detector.processSample(3200, 29 * 40);
  if (peak2) peakCount++;

  assert.equal(peakCount, 2, 'Детектор должен зафиксировать ровно 2 пика');
  assert.ok(detector.getValidRRIntervals().length >= 1);
});
