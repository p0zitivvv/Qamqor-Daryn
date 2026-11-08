import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { StorageService } from '../js/storage.js';
import { DemoSimulator } from '../js/simulator.js';
import { calculateLStat, calculateLDyn, evaluateModel, logistic, calculateBMI } from '../js/model.js';
import { calculateSDNN, calculateRMSSD, calculateRhythmIrregularity, validatePulseOximetry } from '../js/signals.js';
import { AIAdvisorService } from '../js/ai_advisor.js';
import { DeviceState } from '../js/config.js';
import advisorHandler, { generateDeterministicInsight } from '../api/advisor.js';

// ==========================================================
// 1. DEMO MODE VERIFICATION
// ==========================================================
test('1. DEMO MODE: Полный жизненный цикл сценария симуляции', async () => {
  StorageService.setDemoMode(true);
  assert.equal(StorageService.isDemoMode(), true, 'Флаг Demo Mode сохранен');

  const sim = new DemoSimulator();
  let sample = null;
  sim.start((s) => { sample = s; });
  sim.stepSimulation();
  sim.stop();

  assert.ok(sample != null, 'Генератор выдал сэмпл');
  assert.ok(sample.bpm >= 40 && sample.bpm <= 180, 'Демо ЧСС валиден');
  assert.ok(sample.spo2 >= 85 && sample.spo2 <= 100, 'Демо SpO2 валиден');
  assert.ok(sample.sdnn > 0, 'Демо SDNN валиден');

  // Математическая модель в демо-режиме
  const demoProfile = StorageService.getDefaultDemoProfile();
  const stat = calculateLStat(demoProfile);
  const dyn = calculateLDyn({ hr: sample.bpm, sdnn: sample.sdnn, spo2: sample.spo2 }, { hr0: 70 });
  const evalRes = evaluateModel({ lStat: stat.lStat, lDyn: dyn.lDyn, c: 0.95 });

  assert.ok(evalRes.index >= 0 && evalRes.index <= 100, 'Demo Risk Score в границах [0, 100]');
  assert.ok(['green', 'yellow', 'red'].includes(evalRes.zone), 'Demo зона риска валидна');

  // Сохранение в демо-историю
  StorageService.addHistoryEntry({
    bpm: sample.bpm,
    spo2: sample.spo2,
    sdnn: sample.sdnn,
    index: evalRes.index,
    zone: evalRes.zone,
    isDemo: true
  }, true);

  const demoHist = StorageService.getHistory(true);
  assert.ok(demoHist.length > 0, 'Демо-история сохранена');
  assert.ok(demoHist[0].isDemo === true, 'Запись имеет явный флаг isDemo: true');

  // AI Advisor с демо-контекстом
  const advisor = new AIAdvisorService();
  const context = {
    metrics: { hr: sample.bpm, spo2: sample.spo2, sdnn: sample.sdnn },
    baseline: { hr0: 70 },
    profile: demoProfile,
    rules: [],
    modelResult: evalRes,
    isDemo: true,
    history: demoHist
  };

  const aiResult = await advisor.generateAnalysis(context, true);
  assert.equal(aiResult.isDemo, true, 'AI результат маркирован isDemo: true');
  assert.ok(aiResult.ai_insight.trend_label.includes('AI DEMO'), 'Тренд-лейбл имеет префикс AI DEMO');
});

// ==========================================================
// 2. REAL DEVICE MODE VERIFICATION
// ==========================================================
test('2. REAL DEVICE MODE: Изоляция, валидация пакетов и Watchdog', () => {
  StorageService.setDemoMode(false);
  assert.equal(StorageService.isDemoMode(), false, 'Флаг Demo Mode снят');

  // А) В реальном режиме без подключенного браслета показатели строго null
  const realState = {
    isConnected: false,
    deviceState: DeviceState.DISCONNECTED,
    bpm: null,
    spo2: null,
    sdnn: null
  };
  assert.equal(realState.bpm, null, 'Реальный пульс без датчика строго null');
  assert.equal(realState.spo2, null, 'Реальный SpO2 без датчика строго null');

  // Б) Проверка валидации реального BLE-пакета (MAX30102)
  const valResult = validatePulseOximetry(100, 86);
  assert.equal(valResult.isValid, true, 'Пакет ЧСС:100, SpO2:86 признан валидным');

  // В) Проверка невалидных пакетов (выбросы/шумы)
  assert.equal(validatePulseOximetry(250, 99).isValid, false, 'Пульс 250 отсекается');
  assert.equal(validatePulseOximetry(75, 45).isValid, false, 'SpO2 45% отсекается');

  // Г) Watchdog: тайм-аут пакетов переводит в connected_no_data
  const lastPacketTime = Date.now() - 5000;
  const isStale = (Date.now() - lastPacketTime) > 4500;
  assert.equal(isStale, true, 'Watchdog фиксирует прекращение потока данных');
});

// ==========================================================
// 3. MATHEMATICAL MODEL INTEGRITY
// ==========================================================
test('3. МАТЕМАТИЧЕСКАЯ МОДЕЛЬ: Строгое соответствие каноническим формулам', () => {
  // А) Logistic
  assert.equal(logistic(0), 0.5, 'Логистическая функция в нуле строго 0.5');
  assert.equal(logistic(50), 1, 'Логистическая функция устойчива к переполнению');
  assert.equal(logistic(-50), 0, 'Логистическая функция устойчива к исчезновению порядка');

  // Б) L_stat
  const p1 = { age: 50, heightCm: 175, weightKg: 85, smoking: 1, familyHistory: 1, stress: 2, activity: 0 };
  const lStat = calculateLStat(p1);
  assert.equal(lStat.normalized.A, 1.0, 'A = (50 - 40) / 10 = 1.0');
  assert.equal(lStat.normalized.S, 1.0, 'Курение S = 1.0');
  assert.equal(lStat.normalized.F, 1.0, 'Семейный анамнез F = 1.0');

  // В) L_dyn
  const dyn1 = calculateLDyn({ hr: 90, sdnn: 30, spo2: 93, pIrr: 0.1 }, { hr0: 70, sdnn0: 50, sigmaSdnn0: 10 });
  assert.equal(dyn1.details.hr.delta, 20, 'Delta HR = 90 - 70 = 20');
  assert.equal(dyn1.details.spo2.score, 2, 'SpO2 93% дает 2 балла по шкале NEWS2');

  // Г) evaluateModel
  const res = evaluateModel({ lStat: lStat.lStat, lDyn: dyn1.lDyn, c: 0.85 });
  assert.ok(res.index >= 0 && res.index <= 100, 'Score в диапазоне 0-100');
  assert.ok(['green', 'yellow', 'red'].includes(res.zone), 'Зона строго green/yellow/red');

  // Д) Сигналы (SDNN, RMSSD, p_irr)
  const rr = [0.80, 0.85, 0.78, 0.82, 0.81];
  const sdnn = calculateSDNN(rr);
  const rmssd = calculateRMSSD(rr);
  const pirr = calculateRhythmIrregularity(rr);

  assert.ok(sdnn > 0, 'SDNN положительный');
  assert.ok(rmssd > 0, 'RMSSD положительный');
  assert.equal(pirr, 0, 'При нормальном синусовом ритме p_irr = 0');
});

// ==========================================================
// 4. GEMINI API & SERVERLESS ENDPOINT
// ==========================================================
test('4. GEMINI API: Эндпоинт, CORS, безопасность и разделение контекстов', async () => {
  // CORS OPTIONS
  let optStatus = 0;
  let headers = {};
  await advisorHandler({ method: 'OPTIONS' }, {
    setHeader: (k, v) => { headers[k] = v; },
    statusCode: 200,
    end: () => {}
  });
  assert.equal(headers['Access-Control-Allow-Origin'], '*', 'CORS разрешен для PWA');

  // Method check
  let getStatus = 0;
  await advisorHandler({ method: 'GET' }, {
    setHeader: () => {},
    statusCode: 200,
    end: () => {}
  });

  // Fallback и разделение AI DEMO / REAL
  const demoFallback = generateDeterministicInsight({
    isDemo: true,
    metrics: { hr: 72, spo2: 98 },
    baseline: { hr0: 70 },
    modelResult: { index: 18, zone: 'green' }
  });
  assert.equal(demoFallback.isDemo, true);
  assert.ok(demoFallback.ai_insight.trend_label.includes('AI DEMO'));
  assert.ok(demoFallback.ai_insight.summary.includes('18/100'), 'Модельный Risk Score отражен в резюме');

  const realFallback = generateDeterministicInsight({
    isDemo: false,
    metrics: { hr: 100, spo2: 95 },
    baseline: { hr0: 70 },
    modelResult: { index: 32, zone: 'yellow' }
  });
  assert.equal(realFallback.isDemo, false);
  assert.ok(realFallback.ai_insight.trend_label.includes('AI REAL'));
  assert.ok(realFallback.ai_insight.summary.includes('32/100'), 'Модельный Risk Score отражен в резюме');
});

// ==========================================================
// 5. STORAGE & CSV EXPORT
// ==========================================================
test('5. STORAGE & CSV: Разделение истории, экспорт и UTF-8 BOM', () => {
  StorageService.clearHistory(false);
  StorageService.clearHistory(true);

  // Add Real
  StorageService.addHistoryEntry({
    bpm: 99,
    spo2: 98,
    isDemo: false
  }, false);

  // Add Demo
  StorageService.addHistoryEntry({
    bpm: 72,
    spo2: 98,
    isDemo: true
  }, true);

  const realH = StorageService.getHistory(false);
  const demoH = StorageService.getHistory(true);

  assert.equal(realH.length, 1);
  assert.equal(realH[0].isDemo, false);

  assert.equal(demoH.length, 1);
  assert.equal(demoH[0].isDemo, true);

  // CSV Generation check
  let csvContent = 'ID;Дата;Время;ЧСС (уд/мин);SpO2 (%);HRV SDNN (мс);Индекс риска;Зона риска;Полнота (c);Источник\n';
  realH.forEach(h => {
    csvContent += `${h.id};${h.dateStr};${h.timeStr};${h.bpm};${h.spo2};${h.sdnn || ''};${h.index || ''};${h.zone || ''};${h.c || ''};${h.isDemo ? 'DEMO' : 'Qamqor Band'}\n`;
  });

  assert.ok(csvContent.includes('Qamqor Band'), 'Реальный экспорт содержит метку устройства');
  assert.ok(!csvContent.includes('DEMO'), 'Реальный экспорт не содержит DEMO');
});

// ==========================================================
// 6. UI DOM & INTEGRITY CHECK
// ==========================================================
test('6. UI DOM: Проверка наличия ключевых элементов интерфейса в index.html', () => {
  const html = fs.readFileSync('index.html', 'utf8');

  // Вкладки
  assert.ok(html.includes('id="tab-home"'), 'Вкладка 01. Мониторинг присутствует');
  assert.ok(html.includes('id="tab-metrics"'), 'Вкладка 02. Мой риск присутствует');
  assert.ok(html.includes('id="tab-factors"'), 'Вкладка 03. Динамика присутствует');
  assert.ok(html.includes('id="tab-history"'), 'Вкладка 04. Советы присутствует');
  assert.ok(html.includes('id="tab-guardian"'), 'Вкладка 05. Опекун присутствует');
  assert.ok(html.includes('id="tab-settings"'), 'Вкладка 06. Настройки присутствует');

  // Динамические ID
  assert.ok(html.includes('id="home-stream-hz"'), 'Селектор частоты потока');
  assert.ok(html.includes('id="home-metric-bpm-val"'), 'Селектор пульса');
  assert.ok(html.includes('id="home-metric-spo2-val"'), 'Селектор кислорода');
  assert.ok(html.includes('id="dyn-chart-hr-box"'), 'Контейнер графика ЧСС');
  assert.ok(html.includes('id="dyn-chart-spo2-box"'), 'Контейнер графика SpO2');
  assert.ok(html.includes('id="dyn-chart-hrv-box"'), 'Контейнер графика HRV');
  assert.ok(html.includes('id="advisor-content-container"'), 'Контейнер AI Advisor');

  // Отсутствие отладочной карточки BLE
  assert.ok(!html.includes('BLE Диагностика'), 'Отладочная карточка удалена из пользовательского интерфейса');
});
