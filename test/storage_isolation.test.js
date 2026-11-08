import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageService } from '../js/storage.js';

test('1. Полная изоляция Storage: Real Mode vs Demo Mode', () => {
  // Clear both
  StorageService.clearHistory(false);
  StorageService.clearHistory(true);

  assert.equal(StorageService.getHistory(false).length, 0, 'Реальная история изначально пуста');
  assert.equal(StorageService.getHistory(true).length, 0, 'Демо-история очищена');
  
  // Adding Real Entry
  const realEntry = {
    id: 'real-1',
    timestamp: Date.now(),
    date: '08.11.2026',
    time: '20:00',
    bpm: 95,
    spo2: 97,
    sdnn: 45,
    source: 'Qamqor Band (MAX30102)',
    isDemo: false
  };
  StorageService.addHistoryEntry(realEntry, false);

  const realHist = StorageService.getHistory(false);
  assert.equal(realHist.length, 1);
  assert.equal(realHist[0].bpm, 95);
  assert.equal(realHist[0].isDemo, false);

  // Demo History should have 0 entries (no bleeding!)
  let demoHist = StorageService.getHistory(true);
  assert.equal(demoHist.length, 0, 'Реальное измерение не должно попадать в демо-историю');

  // Adding Demo Entry
  const demoEntry = {
    id: 'demo-1',
    timestamp: Date.now(),
    bpm: 72,
    spo2: 98,
    isDemo: true
  };
  StorageService.addHistoryEntry(demoEntry, true);

  demoHist = StorageService.getHistory(true);
  assert.equal(demoHist.length, 1);
  assert.equal(demoHist[0].bpm, 72);
  assert.equal(demoHist[0].isDemo, true);

  // Real history should still only have 1 entry
  const realHistAfter = StorageService.getHistory(false);
  assert.equal(realHistAfter.length, 1);
  assert.equal(realHistAfter[0].id, 'real-1', 'Демо-измерение не должно попадать в реальную историю');
});

test('2. Нормализация и обратная совместимость структуры измерений (date/dateStr, time/timeStr, hr/bpm)', () => {
  const legacyEntry = {
    id: 'legacy-1',
    timestamp: 1700000000000,
    date: '01.01.2026',
    time: '12:30',
    hr: 78,
    spo2: 98,
    hrv: 42
  };

  const normalized = StorageService.normalizeHistoryEntry(legacyEntry);
  assert.equal(normalized.dateStr, '01.01.2026', 'Поле dateStr сформировано из date');
  assert.equal(normalized.timeStr, '12:30', 'Поле timeStr сформировано из time');
  assert.equal(normalized.bpm, 78, 'Поле bpm сформировано из hr');
  assert.equal(normalized.sdnn, 42, 'Поле sdnn сформировано из hrv');
});

test('3. Изоляция кэша AI Advisor: Real Cache vs Demo Cache', () => {
  const realCache = {
    generatedAt: Date.now(),
    isDemo: false,
    badge: 'AI REAL DATA ANALYSIS',
    ai_insight: { summary: 'Реальный анализ биометрии' }
  };

  const demoCache = {
    generatedAt: Date.now(),
    isDemo: true,
    badge: 'AI DEMO ANALYSIS',
    ai_insight: { summary: 'Демонстрационный анализ' }
  };

  StorageService.saveAIAdvisorCache(realCache, false);
  StorageService.saveAIAdvisorCache(demoCache, true);

  const loadedReal = StorageService.getAIAdvisorCache(false);
  const loadedDemo = StorageService.getAIAdvisorCache(true);

  assert.equal(loadedReal.isDemo, false);
  assert.equal(loadedReal.badge, 'AI REAL DATA ANALYSIS');

  assert.equal(loadedDemo.isDemo, true);
  assert.equal(loadedDemo.badge, 'AI DEMO ANALYSIS');
});

test('4. Генерация 7-дневной реалистичной демонстрационной истории', () => {
  const demoList = StorageService.generateDefaultDemoHistory();
  assert.ok(demoList.length >= 7, 'Сгенерировано не менее 7 контрольных точек');
  
  demoList.forEach(pt => {
    assert.ok(pt.bpm >= 60 && pt.bpm <= 110, 'Пульс в физиологических границах');
    assert.ok(pt.spo2 >= 90 && pt.spo2 <= 100, 'SpO2 в валидных границах');
    assert.equal(pt.isDemo, true, 'Каждая точка имеет явный признак DEMO');
    assert.ok(pt.timestamp > 0, 'Имеет корректную временную метку');
  });
});
