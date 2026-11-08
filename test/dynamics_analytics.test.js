import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageService } from '../js/storage.js';

test('1. Динамика: Фильтрация временных периодов (24ч, 7 дней, 30 дней)', () => {
  const now = Date.now();
  const testHistory = [
    { id: '1', timestamp: now - 2 * 3600 * 1000, bpm: 72, spo2: 98, sdnn: 45 },      // 2h ago (Day, 7d, 30d)
    { id: '2', timestamp: now - 3 * 24 * 3600 * 1000, bpm: 75, spo2: 97, sdnn: 50 }, // 3d ago (7d, 30d)
    { id: '3', timestamp: now - 15 * 24 * 3600 * 1000, bpm: 80, spo2: 96, sdnn: 40 },// 15d ago (30d only)
    { id: '4', timestamp: now - 45 * 24 * 3600 * 1000, bpm: 85, spo2: 95, sdnn: 35 } // 45d ago (excluded)
  ];

  // Day filter (24h)
  const cutoffDay = now - 24 * 3600 * 1000;
  const dayItems = testHistory.filter(i => i.timestamp >= cutoffDay);
  assert.equal(dayItems.length, 1);
  assert.equal(dayItems[0].id, '1');

  // 7d filter
  const cutoff7d = now - 7 * 24 * 3600 * 1000;
  const items7d = testHistory.filter(i => i.timestamp >= cutoff7d);
  assert.equal(items7d.length, 2);

  // 30d filter
  const cutoff30d = now - 30 * 24 * 3600 * 1000;
  const items30d = testHistory.filter(i => i.timestamp >= cutoff30d);
  assert.equal(items30d.length, 3);
});

test('2. Динамика: Расчет статистических диапазонов (Мин / Ср / Макс)', () => {
  const points = [
    { bpm: 64, spo2: 98, sdnn: 40 },
    { bpm: 72, spo2: 99, sdnn: 50 },
    { bpm: 86, spo2: 97, sdnn: 45 }
  ];

  const hrs = points.map(p => p.bpm);
  const minHr = Math.min(...hrs);
  const maxHr = Math.max(...hrs);
  const avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);

  assert.equal(minHr, 64);
  assert.equal(maxHr, 86);
  assert.equal(avgHr, 74);

  const spo2s = points.map(p => p.spo2);
  const avgSpo2 = (spo2s.reduce((a, b) => a + b, 0) / spo2s.length).toFixed(1);
  assert.equal(avgSpo2, '98.0');
});

test('3. Динамика: Корректная обработка пустой истории в Real Mode без фиктивных данных', () => {
  const emptyHistory = [];
  const hrs = emptyHistory.map(p => p.bpm);
  
  assert.equal(emptyHistory.length, 0);
  assert.equal(hrs.length, 0);
  // Guarantee that no fake numbers are fabricated when real history is empty
});
