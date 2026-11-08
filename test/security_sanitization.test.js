import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAdvisorService } from '../js/ai_advisor.js';
import { evaluateModel, calculateLStat, calculateLDyn } from '../js/model.js';

test('1. Санитайзер XSS: AIAdvisorService.escapeHTML нейтрализует потенциально вредоносный контент', () => {
  const dangerousScript = '<script>alert("xss")</script>';
  const safeScript = AIAdvisorService.escapeHTML(dangerousScript);
  assert.equal(safeScript.includes('<script>'), false);
  assert.equal(safeScript.includes('&lt;script&gt;'), true);

  const dangerousImg = '<img src=x onerror=alert(1)>';
  const safeImg = AIAdvisorService.escapeHTML(dangerousImg);
  assert.equal(safeImg.includes('<img'), false);
  assert.equal(safeImg.includes('&lt;img'), true);
});

test('2. Математическая модель: Неизменность формул и независимость от внешнего AI', () => {
  const profile = {
    age: 40,
    bmi: 24.5,
    smoking: 0,
    familyHistory: 0,
    stress: 0,
    activity: 1
  };
  const statRes = calculateLStat(profile);
  assert.equal(statRes.normalized.A, 0, 'Нормализованный вектор возраста A = 0');
  assert.ok(statRes.lStat != null, 'L_stat рассчитан');

  const evalRes = evaluateModel({
    lStat: statRes.lStat,
    lDyn: 0,
    c: 0.8
  });

  assert.ok(evalRes.index >= 0 && evalRes.index <= 100, 'Индекс в границах [0, 100]');
  assert.ok(['green', 'yellow', 'red'].includes(evalRes.zone), 'Зона строго одна из [green, yellow, red]');
});
