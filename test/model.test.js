/**
 * Модульные тесты математической модели Qamqor
 * Проверка требований разделов 16.1, 16.2, 16.3, 16.5 спецификации
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logistic,
  clip,
  calculateBMI,
  normalizeAge,
  normalizeBMI,
  calculateLStat,
  validateSurvey,
  calculateSpO2Score,
  calculateLDyn,
  smoothRisk,
  evaluateModel
} from '../js/model.js';
import { MODEL_CONFIG } from '../js/config.js';

// ========================================================
// 16.1. ТЕСТЫ СТАТИЧЕСКОЙ ЧАСТИ
// ========================================================
test('16.1.1 Нормализация возраста: A = (age - 40) / 10', () => {
  assert.equal(normalizeAge(40), 0);
  assert.equal(normalizeAge(50), 1.0);
  assert.equal(normalizeAge(30), -1.0);
  assert.equal(normalizeAge(65), 2.5);

  // Граничные и невалидные значения
  assert.throws(() => normalizeAge(5), RangeError);
  assert.throws(() => normalizeAge(130), RangeError);
  assert.throws(() => normalizeAge(NaN), RangeError);
});

test('16.1.2 Расчет и нормализация ИМТ', () => {
  // Вес 75 кг, рост 1.75 м -> 75 / (1.75^2) ≈ 24.4898
  const bmi = calculateBMI(75, 1.75);
  assert.ok(Math.abs(bmi - 24.48979) < 0.001);

  // Ввод роста в сантиметрах
  const bmiCm = calculateBMI(75, 175);
  assert.ok(Math.abs(bmiCm - 24.48979) < 0.001);

  // Нормализация B = (BMI - 25) / 5
  assert.equal(normalizeBMI(25), 0);
  assert.equal(normalizeBMI(30), 1.0);
  assert.equal(normalizeBMI(20), -1.0);

  // Ошибки при делении на 0 и невалидных значениях
  assert.throws(() => calculateBMI(70, 0), Error);
  assert.throws(() => calculateBMI(-50, 1.8), RangeError);
  assert.throws(() => calculateBMI(70, -1.8), RangeError);
});

test('16.1.3 Применение коэффициентов L_stat и правильный знак активности', () => {
  // Базовый здоровый человек: 40 лет (A=0), ИМТ 25 (B=0), не курит (S=0),
  // нет наследственности (F=0), стресс 0 (Y=0), активность 0 (P=0)
  const baseProfile = {
    age: 40,
    bmi: 25,
    smoking: 0,
    familyHistory: 0,
    stress: 0,
    activity: 0
  };
  const resBase = calculateLStat(baseProfile);
  assert.equal(resBase.lStat, -2.0, 'При базовых значениях L_stat должен быть равен beta_0 = -2.0');

  // Проверка каждого коэффициента по отдельности
  // 1. Возраст 50 лет (+10 лет -> A=1) -> L_stat = -2.0 + 0.50 = -1.50
  assert.equal(calculateLStat({ ...baseProfile, age: 50 }).lStat, -1.50);

  // 2. ИМТ 30 (+5 -> B=1) -> L_stat = -2.0 + 0.25 = -1.75
  assert.equal(calculateLStat({ ...baseProfile, bmi: 30 }).lStat, -1.75);

  // 3. Курение (+0.70) -> L_stat = -2.0 + 0.70 = -1.30
  assert.equal(calculateLStat({ ...baseProfile, smoking: 1 }).lStat, -1.30);

  // 4. Наследственность (+0.40) -> L_stat = -2.0 + 0.40 = -1.60
  assert.equal(calculateLStat({ ...baseProfile, familyHistory: 1 }).lStat, -1.60);

  // 5. Стресс высокий Y=2 (+0.15*2 = +0.30) -> L_stat = -2.0 + 0.30 = -1.70
  assert.equal(calculateLStat({ ...baseProfile, stress: 2 }).lStat, -1.70);

  // 6. Активность высокая P=2 (-0.30*2 = -0.60) ВЫЧИТАЕТСЯ! -> L_stat = -2.0 - 0.60 = -2.60
  assert.equal(calculateLStat({ ...baseProfile, activity: 2 }).lStat, -2.60, 'Активность должна уменьшать L_stat!');
});

// ========================================================
// 16.2. ТЕСТЫ ДИНАМИЧЕСКОЙ ЧАСТИ
// ========================================================
test('16.2.1 Delta HR: ограничение [0, 40]', () => {
  const baseline = { hr0: 70, lnSdnn0: 3.5, sigmaHrv: 0.3 };

  // Отрицательная разница (пульс 60, норма 70) должна быть 0
  const resBelow = calculateLDyn({ hr: 60 }, baseline);
  assert.equal(resBelow.details.hr.delta, 0);
  assert.equal(resBelow.details.hr.weight, 0);

  // Разница 15 уд/мин (пульс 85, норма 70) -> 15 * 0.0077 = 0.1155
  const resMid = calculateLDyn({ hr: 85 }, baseline);
  assert.equal(resMid.details.hr.delta, 15);
  assert.ok(Math.abs(resMid.details.hr.weight - 0.1155) < 0.0001);

  // Превышение выше 40 (пульс 130, норма 70 -> delta=60 -> clip to 40)
  const resHigh = calculateLDyn({ hr: 130 }, baseline);
  assert.equal(resHigh.details.hr.delta, 40);
  assert.ok(Math.abs(resHigh.details.hr.weight - 40 * 0.0077) < 0.0001);
});

test('16.2.2 HRV z-score: ограничение [0, 3] и защита от невалидных значений', () => {
  const baseline = { hr0: 70, lnSdnn0: Math.log(50), sigmaHrv: 0.3 }; // ln(50) ≈ 3.912

  // 1. SDNN равен норме (50 мс) -> z = 0
  const resNorm = calculateLDyn({ sdnn: 50 }, baseline);
  assert.equal(resNorm.details.hrv.z, 0);

  // 2. SDNN выше нормы (70 мс) -> (ln(50) - ln(70))/0.3 < 0 -> clip to 0
  const resHigh = calculateLDyn({ sdnn: 70 }, baseline);
  assert.equal(resHigh.details.hrv.z, 0, 'Высокая HRV не должна давать отрицательный z');

  // 3. SDNN упал до 25 мс -> (ln(50) - ln(25))/0.3 = ln(2)/0.3 ≈ 0.693/0.3 ≈ 2.31
  const resLow = calculateLDyn({ sdnn: 25 }, baseline);
  assert.ok(resLow.details.hrv.z > 2.0 && resLow.details.hrv.z < 2.5);

  // 4. Экстремальное падение SDNN до 5 мс -> clip to 3
  const resVeryLow = calculateLDyn({ sdnn: 5 }, baseline);
  assert.equal(resVeryLow.details.hrv.z, 3.0);

  // 5. Невалидный SDNN (0 или отрицательный) -> пометка unavailable, логарифм не вычисляется!
  const resZero = calculateLDyn({ sdnn: 0 }, baseline);
  assert.equal(resZero.details.hrv.available, false);

  const resNeg = calculateLDyn({ sdnn: -10 }, baseline);
  assert.equal(resNeg.details.hrv.available, false);

  // 6. Нулевая sigma_HRV -> защита от деления на 0
  const resZeroSigma = calculateLDyn({ sdnn: 40 }, { hr0: 70, lnSdnn0: 3.5, sigmaHrv: 0 });
  assert.equal(resZeroSigma.details.hrv.available, false);
});

test('16.2.3 Категориальная шкала SpO2', () => {
  assert.equal(calculateSpO2Score(98), 0, '>= 96% -> 0');
  assert.equal(calculateSpO2Score(96), 0, '>= 96% -> 0');
  assert.equal(calculateSpO2Score(95), 1, '94-95% -> 1');
  assert.equal(calculateSpO2Score(94), 1, '94-95% -> 1');
  assert.equal(calculateSpO2Score(93), 2, '92-93% -> 2');
  assert.equal(calculateSpO2Score(92), 2, '92-93% -> 2');
  assert.equal(calculateSpO2Score(91), 3, '<= 91% -> 3');
  assert.equal(calculateSpO2Score(85), 3, '<= 91% -> 3');

  // Вне диапазона [70, 100]
  assert.throws(() => calculateSpO2Score(50), RangeError);
  assert.throws(() => calculateSpO2Score(105), RangeError);
});

test('16.2.4 Нерегулярность ритма s_ARR = clip(10 * p_irr, 0, 3)', () => {
  const baseline = { hr0: 70, lnSdnn0: 3.5, sigmaHrv: 0.3 };

  // p_irr = 0 -> s_ARR = 0
  const res0 = calculateLDyn({ pIrr: 0 }, baseline);
  assert.equal(res0.details.arr.sArr, 0);

  // p_irr = 0.15 -> s_ARR = 1.5
  const resMid = calculateLDyn({ pIrr: 0.15 }, baseline);
  assert.equal(resMid.details.arr.sArr, 1.5);

  // p_irr = 0.50 -> 10*0.5 = 5 -> clip to 3.0
  const resHigh = calculateLDyn({ pIrr: 0.5 }, baseline);
  assert.equal(resHigh.details.arr.sArr, 3.0);
});

// ========================================================
// 16.3. ТЕСТЫ ЛОГИСТИЧЕСКОЙ ФУНКЦИИ
// ========================================================
test('16.3 Логистическая функция: численная устойчивость и пределы', () => {
  // L = 0 -> r* = 0.5
  assert.equal(logistic(0), 0.5);

  // Результат строго в [0, 1]
  assert.ok(logistic(2.0) > 0.5 && logistic(2.0) < 1.0);
  assert.ok(logistic(-2.0) < 0.5 && logistic(-2.0) > 0.0);

  // Большие положительные и отрицательные L (без переполнения / NaN / Infinity)
  assert.equal(logistic(100), 1.0);
  assert.equal(logistic(-100), 0.0);
  assert.equal(logistic(500), 1.0);
  assert.equal(logistic(-500), 0.0);

  assert.ok(!isNaN(logistic(35)));
  assert.ok(Number.isFinite(logistic(-35)));
});

// ========================================================
// 16.5. ТЕСТЫ СГЛАЖИВАНИЯ (EMA)
// ========================================================
test('16.5 Дискретное сглаживание во времени', () => {
  const alphaExpected = 1 - Math.exp(-1 / 5); // ≈ 0.181269
  assert.ok(Math.abs(MODEL_CONFIG.smoothing.alpha - 0.181269) < 0.0001);

  // Инициализация при rPrev = null
  const rInit = smoothRisk(null, 0.40);
  assert.equal(rInit, 0.40);

  // Шаг сглаживания: r_0 = 0.20, цель r* = 0.60
  // r_1 = 0.20 + alpha * (0.60 - 0.20)
  const rNext = smoothRisk(0.20, 0.60, 1, 5);
  const expectedNext = 0.20 + alphaExpected * 0.40;
  assert.ok(Math.abs(rNext - expectedNext) < 0.00001);

  // Асимптотическое приближение за 15 шагов (3*tau)
  let r = 0.20;
  const target = 0.70;
  for (let k = 0; k < 15; k++) {
    r = smoothRisk(r, target, 1, 5);
  }
  // За 15 минут (3 тау) должно пройти ~95% пути
  assert.ok(Math.abs(r - target) < 0.03);
});

// ========================================================
// КОМПЛЕКСНЫЙ ТЕСТ МОДЕЛИ
// ========================================================
test('Комплексная модель evaluateModel: расчет зон и учет качества c', () => {
  // Молодой здоровый профиль (L_stat = -2.0)
  const resLow = evaluateModel({
    lStat: -2.0,
    lDyn: 0.5,
    c: 1.0,
    rPrev: null
  });
  // L = -2.0 + 0.5 = -1.5 -> r* = 1/(1+e^1.5) ≈ 0.1824 -> I ≈ 18.2 (зеленая зона)
  assert.equal(resLow.zone, 'green');
  assert.ok(resLow.index < 20);

  // При c < 0.5 статус "Недостаточно данных"
  const resBadQuality = evaluateModel({
    lStat: -2.0,
    lDyn: 2.0,
    c: 0.3,
    rPrev: null
  });
  assert.equal(resBadQuality.isDataSufficient, false);
  assert.equal(resBadQuality.statusText, 'Недостаточно данных для расчета');
  assert.equal(resBadQuality.index, null);
});

// ========================================================
// ТЕСТЫ ВАЛИДАЦИИ АНКЕТЫ (БЕЗ ПОДМЕНЫ ДАННЫХ)
// ========================================================
test('16.1.4 Валидация анкеты: полный профиль готов к расчету', () => {
  const fullSurvey = {
    age: 40,
    heightCm: 175,
    weightKg: 75,
    smoking: 0,
    familyHistory: 0,
    stress: 1,
    activity: 2
  };
  const val = validateSurvey(fullSurvey);
  assert.equal(val.isValid, true);
  assert.equal(val.missing.length, 0);
  assert.equal(val.completed.length, 6);
  assert.equal(val.profile.smoking, 0);
  assert.equal(val.profile.familyHistory, 0);
  assert.equal(val.profile.bmi, 24.5);
});

test('16.1.5 Валидация анкеты: «Предпочитаю не отвечать» на вопрос о курении не подменяется нулем', () => {
  const surveyNoSmokingAnswer = {
    age: 40,
    heightCm: 175,
    weightKg: 75,
    smoking: null, // Пользователь отказался отвечать
    familyHistory: 0,
    stress: 1,
    activity: 2
  };
  const val = validateSurvey(surveyNoSmokingAnswer);
  assert.equal(val.isValid, false, 'Анкета не должна считаться валидной без ответа о курении');
  const smokingMissing = val.missing.find(m => m.field === 'smoking');
  assert.ok(smokingMissing, 'Фактор курения должен быть в списке недостающих');
  assert.ok(smokingMissing.reason.includes('Предпочитаю не отвечать'));
  assert.equal(val.profile, null);

  // Прямой вызов calculateLStat обязан выбросить ошибку
  assert.throws(() => calculateLStat(surveyNoSmokingAnswer), Error);
});

test('16.1.6 Валидация анкеты: ответ «Не знаю» о семейном анамнезе не приравнивается к «Нет»', () => {
  const surveyUnknownFamily = {
    age: 40,
    heightCm: 175,
    weightKg: 75,
    smoking: 0,
    familyHistory: null, // Пользователь не знает анамнез
    stress: 1,
    activity: 2
  };
  const val = validateSurvey(surveyUnknownFamily);
  assert.equal(val.isValid, false, 'Ответ «Не знаю» не должен приравниваться к «Нет»');
  const familyMissing = val.missing.find(m => m.field === 'familyHistory');
  assert.ok(familyMissing, 'Семейный анамнез должен быть отмечен как требующий уточнения');
  assert.ok(familyMissing.reason.includes('Не знаю'));

  // evaluateModel при отсутствии lStat возвращает статус неполноты анкеты
  const evalIncomplete = evaluateModel({ lStat: null, lDyn: 0.5, c: 1.0 });
  assert.equal(evalIncomplete.isDataSufficient, false);
  assert.equal(evalIncomplete.index, null);
  assert.equal(evalIncomplete.reason, 'MISSING_SURVEY_DATA');
});
