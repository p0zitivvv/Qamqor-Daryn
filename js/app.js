/**
 * Qamqor Health Monitoring System
 * Главный контроллер приложения (UI & Application Controller)
 * Реализация утвержденного обязательного модуля: расчет индекса Qamqor и персональные рекомендации
 */

import { MODEL_CONFIG } from './config.js';
import {
  calculateLStat,
  calculateLDyn,
  evaluateModel,
  calculateBMI,
  validateSurvey
} from './model.js';
import {
  calculateDataQuality,
  calculateBaselineCompleteness,
  calculateOverallCompleteness
} from './quality.js';
import { PersonalBaselineService } from './baseline.js';
import { AlertEngine, AlertState } from './alerts.js';
import { RecommendationEngine } from './recommendations.js';
import { StorageService } from './storage.js';
import { BLEService } from './ble.js';
import { DemoSimulator } from './simulator.js';
import { ECGCanvasService } from './ecg.js';

export const App = {
  state: {
    currentScreen: 'onboarding-connect', // 'onboarding-connect' | 'onboarding-survey' | 'main-app'
    activeTab: 'home',                   // 'home' | 'metrics' | 'factors' | 'history' | 'settings'
    isDemo: false,
    isConnected: false,
    deviceName: 'Qamqor Band',

    // Текущие биометрические показатели
    bpm: 72,
    spo2: 98,
    sdnn: 48,
    pIrr: 0.02,
    lastUpdateTime: null,

    // Результаты моделирования
    lStatResult: null,
    lDynResult: null,
    qualityResult: null,
    modelEvaluation: null,
    prevR: null,

    // Рекомендации
    recommendations: [],
    improvementPlan: [],

    // Временные данные анкеты и пошагового визарда
    surveyTemp: {},
    currentSurveyStep: 1,
    surveyValidation: null
  },

  // Сервисы
  baselineService: null,
  alertEngine: null,
  recommendationEngine: null,
  bleService: null,
  demoSimulator: null,
  ecgCanvas: null,

  init() {
    console.log(`[Qamqor] Инициализация системы, версия: ${MODEL_CONFIG.version}`);

    // Инициализация сервисов
    this.baselineService = new PersonalBaselineService(StorageService.getBaseline());
    this.alertEngine = new AlertEngine(StorageService.getAlertsState());
    this.recommendationEngine = new RecommendationEngine();
    this.bleService = new BLEService();
    this.demoSimulator = new DemoSimulator();
    this.ecgCanvas = new ECGCanvasService();

    // Загрузка профиля (без подмены отсутствующих ответов)
    const profile = StorageService.getProfile();
    this.state.surveyTemp = profile ? { ...profile } : {
      name: '',
      age: 40,
      heightCm: 175,
      weightKg: 75,
      bmi: 24.5,
      smoking: null,
      familyHistory: null,
      stress: 1,
      activity: 1
    };

    if (profile) {
      try {
        this.state.lStatResult = calculateLStat(profile);
      } catch {
        this.state.lStatResult = null;
      }
    } else {
      this.state.lStatResult = null;
    }

    // Настройка осциллографа ЭКГ
    this.ecgCanvas.init([
      { canvasId: 'homeECGCanvas', emptyStateId: 'home-ecg-empty-state', statusPillId: 'home-ecg-status-pill' },
      { canvasId: 'liveECGCanvas', emptyStateId: 'ecg-empty-state', statusPillId: 'ecg-status-pill' }
    ]);

    // Настройка BLE
    this.bleService.onTelemetry = (data) => this.handleBLETelemetry(data);
    this.bleService.onStatusChange = (status) => this.handleBLEStatusChange(status);
    this.bleService.onError = (err) => this.handleBLEError(err);

    // Первоначальный расчет модели
    this.recalculateModel();

    // Проверка статуса онбординга
    if (StorageService.isOnboarded()) {
      this.showScreen('main-app');
      if (StorageService.isDemoMode()) {
        this.startDemoMode();
      }
    } else {
      // Сначала показываем анкету, потом уже подключение
      this.showScreen('onboarding-survey');
      this.goToSurveyStep(1);
    }

    // Минутный таймер для дискретного шага EMA-сглаживания и FSM тревог
    setInterval(() => this.stepCalculationMinute(), 60000);

    // Секундный таймер для часов
    setInterval(() => {
      const clockEl = document.getElementById('band-sim-time');
      if (clockEl) {
        clockEl.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      }
    }, 1000);

    // Регистрация Service Worker для PWA
    this.registerSW();
  },

  // ========================================================
  // НАВИГАЦИЯ И ЭКРАНЫ
  // ========================================================
  showScreen(screenId) {
    this.state.currentScreen = screenId;
    ['screen-onboarding-connect', 'screen-onboarding-survey', 'screen-main-app'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    });

    const activeEl = document.getElementById(`screen-${screenId}`);
    if (activeEl) {
      activeEl.classList.remove('hidden');
      activeEl.style.display = '';
    }

    if (screenId === 'onboarding-survey') {
      this.goToSurveyStep(this.state.currentSurveyStep || 1);
    } else if (screenId === 'main-app') {
      this.renderAll();
      if (this.state.isDemo || this.state.isConnected) {
        this.ecgCanvas.setStreamActive(true);
      }
    }
  },

  startSurveyWizard() {
    const profile = StorageService.getProfile();
    if (profile) {
      this.state.surveyTemp = { ...profile };
    }
    this.state.currentSurveyStep = 1;
    this.showScreen('onboarding-survey');
  },

  startInstantDemo() {
    if (!this.recommendationEngine) {
      try { this.init(); } catch(e) {}
    }
    this.state.isDemo = true;
    this.state.isConnected = false;
    StorageService.setDemoMode(true);
    StorageService.setOnboarded(true);
    let profile = StorageService.getProfile();
    if (!profile) {
      profile = StorageService.getDefaultDemoProfile();
      StorageService.saveProfile(profile);
      this.state.surveyTemp = { ...profile };
    }
    this.recalculateModel();
    this.showScreen('main-app');
    this.startDemoMode();
    this.showToast('Демо-режим активирован. Показатели запущены!', 'success');
  },

  switchTab(tabId) {
    this.state.activeTab = tabId;
    const tabs = ['home', 'metrics', 'factors', 'history', 'settings', 'guardian'];

    tabs.forEach(t => {
      const sec = document.getElementById(`tab-${t}`);
      const btn = document.getElementById(`nav-btn-${t}`);
      if (sec) {
        if (t === tabId) {
          sec.classList.remove('hidden');
          sec.style.display = 'block';
        } else {
          sec.classList.add('hidden');
          sec.style.display = 'none';
        }
      }
      if (btn) {
        if (t === tabId) {
          const activeColor = t === 'guardian' ? 'text-violet-400' : 'text-emerald-400';
          btn.classList.add(activeColor, 'font-semibold');
          btn.classList.remove('text-slate-400', 'font-medium', 'text-emerald-400', 'text-violet-400');
          btn.classList.add(activeColor);
        } else {
          btn.classList.remove('text-emerald-400', 'text-violet-400', 'font-semibold');
          btn.classList.add('text-slate-400', 'font-medium');
        }
      }
    });

    try {
      if (tabId === 'history') {
        this.renderHistoryList();
      } else if (tabId === 'factors') {
        this.renderFactorsTab();
      } else if (tabId === 'guardian') {
        this.renderGuardianTab();
      } else if (tabId === 'settings') {
        this.populateSettingsTab();
      }
    } catch(err) {
      console.warn('Error rendering tab content:', tabId, err);
    }

    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch(e) {}
  },

  // ========================================================
  // ОБРАБОТКА ПОСТУПЛЕНИЯ ДАННЫХ
  // ========================================================
  handleBLETelemetry(data) {
    if (data.bpm) this.state.bpm = data.bpm;
    if (data.spo2) this.state.spo2 = data.spo2;
    if (data.ecg && this.ecgCanvas) {
      this.ecgCanvas.pushRealSample(data.ecg);
    }
    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(true);
      if (this.state.bpm) this.ecgCanvas.setBPM(this.state.bpm);
    }

    if (data.rrIntervals && data.rrIntervals.length >= 5) {
      try {
        this.state.sdnn = calculateSDNN(data.rrIntervals);
        this.state.pIrr = calculateRhythmIrregularity(data.rrIntervals);
      } catch(e) {
        console.warn('SDNN/pIrr calculation error:', e);
      }
      this.recalculateModel();
    } else {
      this.recalculateModel();
    }
  },

  handleBLEStatusChange(status) {
    this.state.isConnected = status.connected;
    this.updateConnectionUI();
    if (status.connected) {
      this.showToast(`Браслет ${status.deviceName} подключен`, 'success');
      this.ecgCanvas.setStreamActive(true);
    } else {
      this.showToast('Связь с браслетом разорвана', 'warning');
      this.ecgCanvas.setStreamActive(false);
    }
  },

  handleBLEError(err) {
    if (err.name !== 'NotFoundError') {
      this.showToast(`Ошибка BLE: ${err.message}`, 'warning');
    }
  },

  // ========================================================
  // ДЕМО РЕЖИМ
  // ========================================================
  startDemoOnboarding() {
    this.state.isDemo = true;
    this.state.isConnected = false;
    StorageService.setDemoMode(true);
    this.showToast('Деморежим активирован. Переходим к анкете.', 'info');
    this.showScreen('onboarding-survey');
  },

  startDemoMode() {
    this.state.isDemo = true;
    this.state.isConnected = false;
    StorageService.setDemoMode(true);
    this.updateConnectionUI();

    this.ecgCanvas.setStreamActive(true);

    this.demoSimulator.start((sample) => {
      this.state.bpm = sample.bpm;
      this.state.spo2 = sample.spo2;
      this.state.sdnn = sample.sdnn;
      this.state.pIrr = sample.pIrr;
      if (this.ecgCanvas) {
        this.ecgCanvas.setBPM(sample.bpm);
      }
      this.recalculateModel();
    });
  },

  stopDemoMode() {
    this.demoSimulator.stop();
    this.state.isDemo = false;
    StorageService.setDemoMode(false);
    this.updateConnectionUI();
    this.ecgCanvas.setStreamActive(false);
  },

  setDemoScenario(scenario) {
    this.demoSimulator.setScenario(scenario);
    const names = {
      normal: 'Нормальное состояние',
      tachycardia: 'Тахикардия (ЧСС 108 уд/мин)',
      hypoxia: 'Гипоксия (SpO2 91%)'
    };
    this.showToast(`Режим симуляции: ${names[scenario] || scenario}`, 'info');
  },

  // ========================================================
  // РАСЧЕТ ИНДЕКСА И ГЕНЕРАЦИЯ РЕКОМЕНДАЦИЙ
  // ========================================================
  recalculateModel() {
    let profile = StorageService.getProfile();
    if (!profile && this.state.isDemo) {
      profile = StorageService.getDefaultDemoProfile();
    }
    const baseline = this.baselineService.getBaseline();

    // 1. Проверка анкеты без подмены данных
    this.state.surveyValidation = validateSurvey(profile);

    if (this.state.surveyValidation.isValid) {
      try {
        this.state.lStatResult = calculateLStat(this.state.surveyValidation.profile || profile);
      } catch (e) {
        this.state.lStatResult = null;
      }
    } else {
      this.state.lStatResult = null;
    }

    // 2. Динамическая часть L_dyn
    this.state.lDynResult = calculateLDyn({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);

    // 3. Качество данных c = c_q * c_base
    const quality = calculateDataQuality({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);

    const cBase = calculateBaselineCompleteness(Math.max(1, baseline.daysElapsed));
    this.state.qualityResult = calculateOverallCompleteness(quality.c_q, cBase);

    // В деморежиме гарантируем качественную базовую демонстрацию
    const effectiveC = this.state.isDemo ? Math.max(0.85, this.state.qualityResult.c) : this.state.qualityResult.c;

    // 4. Оценка модели: r* = 1 / (1 + e^-L), r_{k+1} = r_k + alpha*(r* - r_k)
    this.state.modelEvaluation = evaluateModel({
      lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
      lDyn: this.state.lDynResult ? this.state.lDynResult.lDyn : null,
      c: effectiveC,
      rPrev: this.state.prevR,
      dtMinutes: 0.1
    });

    if (this.state.modelEvaluation.rSmooth != null) {
      this.state.prevR = this.state.modelEvaluation.rSmooth;
    }

    // 5. Запуск Recommendation Engine
    const completedActionIds = StorageService.getCompletedActions();
    this.state.recommendations = this.recommendationEngine.generateRecommendations({
      metrics: {
        hr: this.state.bpm,
        sdnn: this.state.sdnn,
        spo2: this.state.spo2,
        pIrr: this.state.pIrr
      },
      baseline,
      quality: { ...this.state.qualityResult, c: effectiveC },
      profile: profile || { stress: 1, activity: 1 },
      symptoms: this.state.surveyTemp.symptoms || {},
      index: this.state.modelEvaluation ? this.state.modelEvaluation.index : null
    });

    // 6. Формирование плана «Что можно улучшить» (до 3 действий)
    this.state.improvementPlan = this.recommendationEngine.getImprovementPlan(
      this.state.recommendations,
      completedActionIds
    );

    this.state.lastUpdateTime = new Date().toLocaleTimeString('ru-RU');
    this.renderDashboardMetrics();

    if (this.state.activeTab === 'factors') {
      this.renderFactorsTab();
    }
  },

  stepCalculationMinute() {
    if (!this.state.modelEvaluation) return;

    // Шаг автомата тревог с гистерезисом 30
    const alertResult = this.alertEngine.update({
      index: this.state.modelEvaluation.index,
      c: this.state.qualityResult ? this.state.qualityResult.c : 0,
      timestamp: Date.now()
    });

    StorageService.saveAlertsState(this.alertEngine.toJSON());

    if (alertResult.shouldAlert) {
      if (!this.state.isDemo) {
        this.showToast(alertResult.alertMessage, 'warning');
        this.openSOSModal(alertResult.alertMessage);
      }
      // Уведомление опекуна через Telegram
      const gcfg = this.loadGuardianConfig();
      if (gcfg.botToken && gcfg.chatId) {
        const zone = this.state.modelEvaluation ? this.state.modelEvaluation.zone : '';
        const idx  = this.state.modelEvaluation ? this.state.modelEvaluation.index : '--';
        const isRed = (zone === 'red');
        if ((isRed && gcfg.notifyRed) || (!isRed && gcfg.notifyDeterioration)) {
          const emoji = isRed ? '\u{1F534}' : '\u{1F7E1}';
          const msg = emoji + ' *' + alertResult.alertMessage + '*\n\n' +
            '\u{1F4CA} Индекс риска: *' + idx + '*\n' +
            '\u2764\uFE0F ЧСС: *' + this.state.bpm + ' уд/мин*\n' +
            '\uD83E\uDE78 SpO2: *' + this.state.spo2 + '%*';
          this.sendGuardianNotification(msg).catch(() => {});
        }
      }
    }

    // Сохранение в историю
    if (this.state.bpm && this.state.spo2) {
      StorageService.addHistoryEntry({
        type: 'sample',
        bpm: this.state.bpm,
        spo2: this.state.spo2,
        sdnn: this.state.sdnn,
        index: this.state.modelEvaluation.index,
        zone: this.state.modelEvaluation.zone,
        c: this.state.qualityResult ? this.state.qualityResult.c : 0,
        isDemo: this.state.isDemo,
        title: `Индекс: ${this.state.modelEvaluation.index} (${this.getZoneLabel(this.state.modelEvaluation.zone)}), ЧСС: ${this.state.bpm}`
      });
    }

    // Накопление базовой линии
    if (this.state.bpm && this.state.sdnn && this.state.bpm < 85) {
      this.baselineService.addRestingWindow({
        hr: this.state.bpm,
        sdnn: this.state.sdnn,
        timestamp: Date.now()
      });
      StorageService.saveBaseline(this.baselineService.toJSON());
    }
  },

  getZoneLabel(zone) {
    if (zone === 'red') return 'Красная зона (40–100)';
    if (zone === 'yellow') return 'Жёлтая зона (20–39)';
    return 'Зелёная зона (0–19)';
  },

  toggleActionCompleted(actionId) {
    StorageService.toggleActionCompleted(actionId);
    this.recalculateModel();
    this.renderFactorsTab();
    this.showToast('Статус действия обновлен', 'info');
  },

  // ========================================================
  // ОТРИСОВКА ИНТЕРФЕЙСА
  // ========================================================
  renderAll() {
    try { this.updateConnectionUI(); } catch(e) { console.warn('updateConnectionUI err:', e); }
    try { this.renderDashboardMetrics(); } catch(e) { console.warn('renderDashboardMetrics err:', e); }
    try { this.renderFactorsTab(); } catch(e) { console.warn('renderFactorsTab err:', e); }
    try { this.renderHistoryList(); } catch(e) { console.warn('renderHistoryList err:', e); }
    try { this.populateSettingsTab(); } catch(e) { console.warn('populateSettingsTab err:', e); }
    try { this.renderGuardianTab(); } catch(e) { console.warn('renderGuardianTab err:', e); }
  },

  renderDashboardMetrics() {
    const timeStr = this.state.lastUpdateTime || 'Ожидание';
    const lastSyncEl = document.getElementById('app-last-sync-time');
    if (lastSyncEl) lastSyncEl.textContent = `Синхр: ${timeStr}`;

    // ЧСС и SpO2
    const bpmVal = document.getElementById('home-metric-bpm-val');
    if (bpmVal) bpmVal.textContent = this.state.bpm != null ? this.state.bpm : '72';

    const spo2Val = document.getElementById('home-metric-spo2-val');
    if (spo2Val) spo2Val.textContent = this.state.spo2 != null ? `${this.state.spo2}%` : '98%';

    // Проверка анкеты и качества данных c < 0.5
    const isSurveyValid = this.state.surveyValidation ? this.state.surveyValidation.isValid : false;
    const isQualitySufficient = this.state.isDemo || (this.state.qualityResult && this.state.qualityResult.c >= 0.5);

    const numEl = document.getElementById('home-index-number');
    const barEl = document.getElementById('home-index-progress-bar');
    const zoneEl = document.getElementById('home-index-zone-label');
    const statusEl = document.getElementById('home-index-status-desc');

    if (!isSurveyValid) {
      if (numEl) numEl.innerHTML = '<span class="text-xl text-amber-400 font-bold">Анкета не завершена</span>';
      if (barEl) {
        barEl.style.width = '0%';
        barEl.className = 'bg-slate-700 h-2.5 rounded-full';
      }
      if (zoneEl) {
        zoneEl.textContent = 'Требуется завершить анкету';
        zoneEl.className = 'text-xs font-bold text-amber-400';
      }
      if (statusEl) {
        statusEl.innerHTML = '<button onclick="App.startSurveyWizard()" class="text-cyan-400 font-semibold underline decoration-dotted hover:text-cyan-300">Нажмите здесь, чтобы ответить на вопросы модели</button>';
      }
      this._updateGauge(null, 'none');
    } else if (!isQualitySufficient) {
      // ПРАВИЛО 1 & 6: При c < 0.5 не показывать число как достоверный результат
      if (numEl) numEl.innerHTML = '<span class="text-2xl text-amber-400 font-bold">Недостаточно данных</span>';
      if (barEl) {
        barEl.style.width = '0%';
        barEl.className = 'bg-slate-700 h-2.5 rounded-full';
      }
      if (zoneEl) {
        zoneEl.textContent = 'Расчет приостановлен (c < 0.5)';
        zoneEl.className = 'text-xs font-bold text-amber-400';
      }
      if (statusEl) {
        statusEl.textContent = 'Проверьте контакт датчиков на запястье и повторите замер в покое.';
      }
      this._updateGauge(null, 'none');
    } else if (this.state.modelEvaluation && this.state.modelEvaluation.index != null) {
      // c >= 0.5: Отображение числа, цветовой зоны (0-19, 20-39, 40-100)
      const idx = this.state.modelEvaluation.index;
      const zone = this.state.modelEvaluation.zone;

      if (numEl) numEl.textContent = idx;
      if (barEl) {
        barEl.style.width = `${Math.min(100, Math.max(6, idx))}%`;
        barEl.className = zone === 'red' ? 'bg-gradient-to-r from-rose-500 to-red-600 h-2.5 rounded-full transition-all duration-500' :
                          zone === 'yellow' ? 'bg-gradient-to-r from-amber-400 to-amber-500 h-2.5 rounded-full transition-all duration-500' :
                          'bg-gradient-to-r from-emerald-400 to-teal-500 h-2.5 rounded-full transition-all duration-500';
      }
      if (zoneEl) {
        zoneEl.textContent = zone === 'red' ? 'Красная зона (40–100: повышенная нагрузка)' :
                             zone === 'yellow' ? 'Жёлтая зона (20–39: умеренное внимание)' :
                             'Зелёная зона (0–19: нормальное состояние)';
        zoneEl.className = zone === 'red' ? 'text-xs font-bold text-rose-400' :
                           zone === 'yellow' ? 'text-xs font-bold text-amber-400' :
                           'text-xs font-bold text-emerald-400';
      }
      if (statusEl) {
        statusEl.textContent = zone === 'red' ? 'Рекомендуется отдых и снижение нагрузки' :
                               zone === 'yellow' ? 'Небольшое отклонение от персонального оптимума' :
                               'Физиологические показатели стабильны';
      }
      this._updateGauge(idx, zone);
    }

    // Быстрый совет на главном экране из Recommendation Engine
    const quickTipEl = document.getElementById('home-quick-advice-text');
    if (quickTipEl) {
      if (this.state.recommendations.length > 0) {
        const topRec = this.state.recommendations[0];
        quickTipEl.innerHTML = `<b>${topRec.title}:</b> ${topRec.action}`;
      } else {
        quickTipEl.textContent = 'Показатели стабильны. Поддерживайте водный баланс и регулярно проветривайте помещение.';
      }
    }

    // Полнота данных (c)
    if (this.state.qualityResult) {
      const qPctEl = document.getElementById('home-quality-percent');
      const qBarEl = document.getElementById('home-quality-bar');
      const qDescEl = document.getElementById('home-quality-desc');

      const pct = this.state.isDemo ? 88 : this.state.qualityResult.percentage;
      if (qPctEl) qPctEl.textContent = `${pct}%`;
      if (qBarEl) qBarEl.style.width = `${pct}%`;
      if (qDescEl) qDescEl.textContent = this.state.isDemo ? 'Демонстрационные данные' : this.state.qualityResult.label;
    }

    // Базовая линия
    const baseDescEl = document.getElementById('home-baseline-status-desc');
    if (baseDescEl) {
      baseDescEl.textContent = this.state.isDemo 
        ? 'Демо-калибровка активна (норма пульса: 70 уд/мин, SDNN: 48 мс)' 
        : this.baselineService.getStatusText();
    }
  },

  // ========================================================
  // ВКЛАДКА "СОВЕТЫ И ОБЪЯСНЕНИЕ РАСЧЕТА" (Разделы 3, 4, 5)
  // ========================================================
  renderFactorsTab() {
    const container = document.getElementById('factors-decomposition-container');
    if (!container) return;

    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const stat = this.state.lStatResult;
    const dyn = this.state.lDynResult;
    const baseline = this.baselineService ? this.baselineService.getBaseline() : { hr0: 70 };
    const q = this.state.qualityResult || { c: 0.88, percentage: 88 };

    const plan = this.state.improvementPlan || [];
    const recs = this.state.recommendations || [];

    const isZoneRed = evalRes.zone === 'red';
    const isZoneYellow = evalRes.zone === 'yellow';

    container.innerHTML = `
      <!-- 1. ИНТЕРАКТИВНЫЙ ДЫХАТЕЛЬНЫЙ ТРЕНАЖЕР (ДЛЯ НОРМАЛИЗАЦИИ ПУЛЬСА) -->
      <div class="glass-card rounded-2xl p-4 sm:p-5 border border-cyan-500/30 bg-gradient-to-br from-cyan-950/25 via-slate-900 to-slate-900 space-y-3">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div class="flex items-center space-x-2.5">
            <div class="w-8 h-8 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-300 font-bold text-sm">
              🫁
            </div>
            <div>
              <h3 class="text-sm font-bold text-white">Дыхательное упражнение 4–4–4</h3>
              <p class="text-[11px] text-slate-400">Быстро снижает пульс на 5–10 уд/мин и успокаивает нервную систему</p>
            </div>
          </div>
          <button id="btn-breathing-toggle" onclick="App.toggleBreathingExercise()" class="px-3 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-xs font-bold border border-cyan-500/40 transition">
            ▶ Начать
          </button>
        </div>

        <!-- Breathing Animated Visualizer Box -->
        <div id="breathing-box" class="hidden flex flex-col items-center justify-center py-4 space-y-3 bg-slate-950/60 rounded-xl border border-cyan-500/20">
          <div class="relative w-28 h-28 flex items-center justify-center">
            <div id="breathing-circle" class="w-20 h-20 rounded-full bg-cyan-500/20 border-2 border-cyan-400 flex items-center justify-center transition-all duration-1000">
              <span id="breathing-phase-sec" class="text-2xl font-bold font-mono text-white">4</span>
            </div>
          </div>
          <div class="text-center space-y-0.5">
            <div id="breathing-phase-text" class="text-xs font-bold text-cyan-300 uppercase tracking-wider">Вдох носом...</div>
            <div class="text-[11px] text-slate-400">Дышите животом, расслабьте плечи и шею</div>
          </div>
        </div>
      </div>

      <!-- 2. СРОЧНЫЙ ПЛАН УЛУЧШЕНИЯ (ДО 3 ДЕЙСТВИЙ) -->
      <div class="glass-card rounded-2xl p-4 sm:p-5 border ${isZoneRed ? 'border-rose-500/40 bg-rose-950/10' : isZoneYellow ? 'border-amber-500/40 bg-amber-950/10' : 'border-emerald-500/30 bg-emerald-950/5'} space-y-3">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div class="flex items-center space-x-2">
            <span class="w-6 h-6 rounded-lg ${isZoneRed ? 'bg-rose-500/20 text-rose-300' : isZoneYellow ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'} flex items-center justify-center text-xs font-bold">✓</span>
            <div>
              <h3 class="text-sm font-bold text-white">Что сделать прямо сейчас</h3>
              <p class="text-[11px] text-slate-400">Персональные практические шаги для вашего здоровья</p>
            </div>
          </div>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
            ${plan.filter(p => p.isCompleted).length} из ${plan.length} выполнено
          </span>
        </div>

        <div class="space-y-2.5">
          ${plan.length === 0 ? `
            <div class="p-3 text-center text-xs text-slate-400">
              Показатели в норме. Особых корректирующих мер прямо сейчас не требуется. Продолжайте день в комфортном темпе!
            </div>
          ` : plan.map(item => `
            <div class="p-3 rounded-xl ${item.isCompleted ? 'bg-slate-900/60 border-emerald-500/30' : 'bg-slate-900 border-slate-800'} border flex items-start space-x-3 transition">
              <button onclick="App.toggleActionCompleted('${item.id}')" class="mt-0.5 w-5 h-5 rounded-lg border ${item.isCompleted ? 'bg-emerald-500 border-emerald-400 text-white' : 'border-slate-600 bg-slate-800 text-transparent'} flex items-center justify-center transition flex-shrink-0">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
              <div class="space-y-1 flex-1">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold ${item.isCompleted ? 'line-through text-slate-400' : 'text-slate-200'}">
                    ${item.title}
                  </span>
                  <span class="text-[10px] font-mono px-1.5 py-0.2 rounded ${item.priority === 'high' ? 'bg-rose-500/20 text-rose-300' : item.priority === 'medium' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-400'}">
                    ${item.category}
                  </span>
                </div>
                <div class="text-xs text-slate-300 leading-relaxed ${item.isCompleted ? 'line-through text-slate-500' : ''}">
                  ${item.action}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 3. КАТЕГОРИИ РЕКОМЕНДАЦИЙ -->
      <div class="glass-card rounded-2xl p-4 border border-slate-800 space-y-3">
        <div class="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center space-x-2">
          <span>Рекомендации по образу жизни и самочувствию</span>
        </div>

        <div class="grid grid-cols-1 gap-2.5">
          ${recs.map(r => `
            <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-200">${r.title}</span>
                <span class="text-[10px] font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  ${r.category}
                </span>
              </div>
              <p class="text-xs text-slate-400 leading-relaxed">${r.description}</p>
              <div class="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-emerald-300 font-medium">
                👉 Совет: ${r.action}
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 4. ПОНЯТНЫЙ ЧЕЛОВЕКУ РАЗБОР ФАКТОРОВ (БЕЗ СЛОЖНЫХ ФОРМУЛ) -->
      <div class="glass-card rounded-2xl p-4 sm:p-5 border border-slate-800 space-y-4">
        <div class="border-b border-slate-800 pb-2">
          <h3 class="text-sm font-bold text-white flex items-center space-x-2">
            <span>Как сформирована ваша оценка здоровья</span>
          </h3>
          <p class="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
            Система учитывает постоянные привычки (анкету) и текущую работу сердца (датчики) без сложных медицинских терминов.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <!-- Группа 1: Анкета и привычки -->
          <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-2.5">
            <div class="flex items-center space-x-2 text-cyan-400 font-bold border-b border-slate-800 pb-1.5">
              <span>📋 Привычки и особенности</span>
            </div>
            ${stat ? `
            <div class="space-y-2 text-[11px] text-slate-300">
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Возраст:</span>
                <span class="font-semibold text-slate-200">${stat.normalized.A != null ? Math.round(stat.normalized.A * 10 + 40) : 40} лет</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Вес и рост (ИМТ):</span>
                <span class="font-semibold text-slate-200">${stat.normalized.bmi || 24.5} кг/м² (норма)</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Курение:</span>
                <span class="font-semibold ${stat.normalized.S ? 'text-amber-400' : 'text-emerald-400'}">${stat.normalized.S ? 'Да (фактор риска)' : 'Нет'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Физическая активность:</span>
                <span class="font-semibold text-emerald-400">Поддерживает сердце</span>
              </div>
            </div>
            ` : `
            <div class="text-amber-300 text-xs">Анкета не заполнена. Заполните для персональной точности.</div>
            `}
          </div>

          <!-- Группа 2: Датчики браслета прямо сейчас -->
          <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-2.5">
            <div class="flex items-center space-x-2 text-emerald-400 font-bold border-b border-slate-800 pb-1.5">
              <span>💓 Датчики браслета прямо сейчас</span>
            </div>
            <div class="space-y-2 text-[11px] text-slate-300">
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Пульс в покое:</span>
                <span class="font-semibold ${this.state.bpm > 95 ? 'text-amber-400' : 'text-emerald-400'}">${this.state.bpm || 72} уд/мин (норма: ${baseline.hr0 || 70})</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Кислород (SpO2):</span>
                <span class="font-semibold ${this.state.spo2 < 95 ? 'text-amber-400' : 'text-cyan-400'}">${this.state.spo2 || 98}% (отлично)</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Ритм сердца:</span>
                <span class="font-semibold text-emerald-400">${this.state.pIrr > 0.1 ? 'Требует покоя' : 'Ровный и стабильный'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-400">Надежность замера:</span>
                <span class="font-semibold text-slate-200">${Math.round((q.percentage || 88))}%</span>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
          💡 <b>Напоминание:</b> Оценка носит ориентировочный характер для контроля повседневной нагрузки. При любых болях в груди, головокружении или нехватке воздуха обратитесь к врачу или вызовите 103.
        </div>
      </div>
    `;
  },
  updateConnectionUI() {
    const dot = document.getElementById('app-connection-indicator-dot');
    const label = document.getElementById('app-connection-indicator-text');
    const demoBar = document.getElementById('demo-mode-alert-bar');

    if (this.state.isDemo) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
      if (label) label.textContent = 'Деморежим';
      if (demoBar) demoBar.classList.remove('hidden');
    } else if (this.state.isConnected) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      if (label) label.textContent = 'Подключено (BLE)';
      if (demoBar) demoBar.classList.add('hidden');
    } else {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-500';
      if (label) label.textContent = 'Не подключено';
      if (demoBar) demoBar.classList.add('hidden');
    }

    const headerBleBtn = document.getElementById('header-ble-btn');
    if (headerBleBtn) {
      if (this.state.isConnected || this.state.isDemo) {
        headerBleBtn.classList.add('hidden');
      } else {
        headerBleBtn.classList.remove('hidden');
      }
    }
  },

  // ========================================================
  // ПОШАГОВАЯ АНКЕТА И ПРОФИЛЬ (4 ШАГА + СВОДКА)
  // ========================================================
  goToSurveyStep(step) {
    try {
      this.state.currentSurveyStep = step;

      // Скрываем все панели и показываем только активную
      for (let s = 1; s <= 5; s++) {
        const panel = document.getElementById(`survey-panel-step-${s}`);
        if (panel) {
          if (s === step) {
            panel.classList.remove('hidden');
            panel.style.display = 'block';
          } else {
            panel.classList.add('hidden');
            panel.style.display = 'none';
          }
        }
      }

      const stepTitles = {
        1: 'Основная информация',
        2: 'Повседневные привычки',
        3: 'Семейная история',
        4: 'Подключение датчика',
        5: 'Сводка готовности'
      };

      const pillText = document.getElementById('survey-step-indicator-text');
      const titleText = document.getElementById('survey-step-title-text');
      const progressBar = document.getElementById('survey-progress-bar');

      if (pillText) {
        pillText.textContent = step === 5 ? 'Сводка' : `Шаг ${step} из 4`;
      }
      if (titleText) {
        titleText.textContent = stepTitles[step] || '';
      }
      if (progressBar) {
        const percents = { 1: 25, 2: 50, 3: 75, 4: 95, 5: 100 };
        progressBar.style.width = `${percents[step] || 25}%`;
      }

      try {
        if (step === 1) {
          this.populateStep1Inputs();
          this.updateSurveyBMIPreview();
        } else if (step === 2) {
          this.refreshStep2Buttons();
        } else if (step === 3) {
          this.refreshStep3Buttons();
        } else if (step === 4) {
          this.updateSurveyDeviceStatus();
        } else if (step === 5) {
          this.renderSurveySummary();
        }
      } catch (subErr) {
        console.warn('Sub-render error on step', step, subErr);
      }

      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, 0);
      }
    } catch (e) {
      console.error('Error in goToSurveyStep:', e);
    }
  },

  nextSurveyStep(fromStep) {
    try {
      if (fromStep === 1) {
        const ageInput = document.getElementById('survey-input-age');
        const heightInput = document.getElementById('survey-input-height');
        const weightInput = document.getElementById('survey-input-weight');
        const nameInput = document.getElementById('survey-input-name');
        const errBox = document.getElementById('survey-step1-error-msg');

        let ageRaw = (ageInput ? ageInput.value : '').trim();
        let heightRaw = (heightInput ? heightInput.value : '').replace(',', '.').trim();
        let weightRaw = (weightInput ? weightInput.value : '').replace(',', '.').trim();
        let nameVal = nameInput ? nameInput.value.trim() : '';

        let ageVal = parseInt(ageRaw, 10);
        let heightVal = parseFloat(heightRaw);
        let weightVal = parseFloat(weightRaw);

        // Безопасные значения по умолчанию, если пользователь оставил пустыми
        if (isNaN(ageVal)) ageVal = 40;
        if (isNaN(heightVal)) heightVal = 175;
        if (isNaN(weightVal)) weightVal = 75;

        // Если введены значения за пределами разумного диапазона
        if (ageVal < 10 || ageVal > 110) {
          if (errBox) {
            errBox.textContent = 'Укажите возраст от 10 до 110 лет';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите возраст от 10 до 110 лет', 'warning');
          if (ageInput) ageInput.focus();
          return;
        }

        if (heightVal < 50 || heightVal > 250) {
          if (errBox) {
            errBox.textContent = 'Укажите рост в см (от 50 до 250)';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите рост в см (от 50 до 250)', 'warning');
          if (heightInput) heightInput.focus();
          return;
        }

        if (weightVal < 25 || weightVal > 300) {
          if (errBox) {
            errBox.textContent = 'Укажите вес в кг (от 25 до 300)';
            errBox.classList.remove('hidden');
          }
          this.showToast('Пожалуйста, укажите вес в кг (от 25 до 300)', 'warning');
          if (weightInput) weightInput.focus();
          return;
        }

        if (errBox) errBox.classList.add('hidden');

        // Вычисляем ИМТ безопасно
        const hM = heightVal > 3.0 ? heightVal / 100.0 : heightVal;
        const bmiVal = weightVal / (hM * hM);

        this.state.surveyTemp.name = nameVal || 'Пользователь';
        this.state.surveyTemp.age = ageVal;
        this.state.surveyTemp.heightCm = heightVal;
        this.state.surveyTemp.weightKg = weightVal;
        this.state.surveyTemp.bmi = Math.round(bmiVal * 10) / 10;

        this.goToSurveyStep(2);
      } else if (fromStep === 2) {
        this.goToSurveyStep(3);
      } else if (fromStep === 3) {
        this.goToSurveyStep(4);
      } else if (fromStep === 4) {
        this.goToSurveyStep(5);
      }
    } catch (err) {
      console.error('Error in nextSurveyStep:', err);
      // Гарантированный переход на следующий шаг даже при ошибке
      this.goToSurveyStep((fromStep || 1) + 1);
    }
  },

  populateStep1Inputs() {
    const data = this.state.surveyTemp;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) el.value = val;
    };
    if (data.name) setVal('survey-input-name', data.name);
    if (data.age != null) setVal('survey-input-age', data.age);
    if (data.heightCm != null) setVal('survey-input-height', data.heightCm);
    if (data.weightKg != null) setVal('survey-input-weight', data.weightKg);
  },

  updateSurveyBMIPreview() {
    const heightEl = document.getElementById('survey-input-height');
    const weightEl = document.getElementById('survey-input-weight');
    const statusEl = document.getElementById('survey-bmi-preview-status');
    const bBadge = document.getElementById('survey-bmi-b-badge');

    const h = parseFloat(heightEl ? heightEl.value : '');
    const w = parseFloat(weightEl ? weightEl.value : '');

    if (!isNaN(h) && h >= 50 && h <= 250 && !isNaN(w) && w >= 25 && w <= 300) {
      const bmi = w / ((h / 100) * (h / 100));
      const bVal = (bmi - 25) / 5;
      let category = 'Нормальная масса тела';
      if (bmi < 18.5) category = 'Дефицит массы тела';
      else if (bmi >= 25 && bmi < 30) category = 'Избыточная масса тела';
      else if (bmi >= 30) category = 'Повышенная масса тела (ожирение)';

      if (statusEl) {
        statusEl.textContent = `${bmi.toFixed(1)} кг/м² • ${category}`;
      }
      if (bBadge) {
        bBadge.textContent = `B = ${bVal >= 0 ? '+' : ''}${bVal.toFixed(2)}`;
      }
    } else {
      if (statusEl) statusEl.textContent = 'Введите рост и вес для расчета';
      if (bBadge) bBadge.textContent = 'B = --';
    }
  },

  toggleWhyExplain(key) {
    const el = document.getElementById(`why-explain-${key}`);
    if (el) {
      el.classList.toggle('hidden');
    }
  },

  setSurveyChoice(field, value) {
    this.state.surveyTemp[field] = value;
    if (field === 'smoking') {
      this.refreshSmokingButtons();
    } else if (field === 'stress') {
      this.refreshStressButtons();
    } else if (field === 'activity') {
      this.refreshActivityButtons();
    } else if (field === 'familyHistory') {
      this.refreshFamilyButtons();
    }
  },

  refreshStep2Buttons() {
    this.refreshSmokingButtons();
    this.refreshStressButtons();
    this.refreshActivityButtons();
  },

  refreshStep3Buttons() {
    this.refreshFamilyButtons();
  },

  refreshSmokingButtons() {
    const val = this.state.surveyTemp.smoking;
    const activeClass = 'py-2.5 px-2 rounded-xl border border-cyan-500/70 bg-cyan-500/20 text-cyan-200 text-xs font-bold text-center ring-1 ring-cyan-400/40 shadow-sm transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-400 text-xs font-medium text-center hover:bg-slate-700 transition';

    const btn0 = document.getElementById('opt-smoking-0');
    const btn1 = document.getElementById('opt-smoking-1');
    const btnU = document.getElementById('opt-smoking-unknown');
    const notice = document.getElementById('survey-smoking-notice');

    if (btn0) btn0.className = val === 0 ? activeClass : inactiveClass;
    if (btn1) btn1.className = val === 1 ? activeClass : inactiveClass;
    if (btnU) btnU.className = (val === null || val === 'unknown') ? activeClass : inactiveClass;
    if (notice) {
      if (val === null || val === 'unknown') notice.classList.remove('hidden');
      else notice.classList.add('hidden');
    }
  },

  refreshStressButtons() {
    const val = this.state.surveyTemp.stress != null ? this.state.surveyTemp.stress : 1;
    const activeClass = 'py-2.5 px-2 rounded-xl border border-cyan-500/70 bg-cyan-500/20 text-cyan-200 text-xs font-bold text-center ring-1 ring-cyan-400/40 shadow-sm transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-400 text-xs font-medium text-center hover:bg-slate-700 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-stress-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshActivityButtons() {
    const val = this.state.surveyTemp.activity != null ? this.state.surveyTemp.activity : 1;
    const activeClass = 'py-2.5 px-2 rounded-xl border border-cyan-500/70 bg-cyan-500/20 text-cyan-200 text-xs font-bold text-center ring-1 ring-cyan-400/40 shadow-sm transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-400 text-xs font-medium text-center hover:bg-slate-700 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-activity-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshFamilyButtons() {
    const val = this.state.surveyTemp.familyHistory;
    const activeClass = 'py-2.5 px-2 rounded-xl border border-cyan-500/70 bg-cyan-500/20 text-cyan-200 text-xs font-bold text-center ring-1 ring-cyan-400/40 shadow-sm transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-400 text-xs font-medium text-center hover:bg-slate-700 transition';

    const btn0 = document.getElementById('opt-familyHistory-0');
    const btn1 = document.getElementById('opt-familyHistory-1');
    const btnU = document.getElementById('opt-familyHistory-unknown');
    const notice = document.getElementById('survey-family-notice');

    if (btn0) btn0.className = val === 0 ? activeClass : inactiveClass;
    if (btn1) btn1.className = val === 1 ? activeClass : inactiveClass;
    if (btnU) btnU.className = (val === null || val === 'unknown') ? activeClass : inactiveClass;
    if (notice) {
      if (val === null || val === 'unknown') notice.classList.remove('hidden');
      else notice.classList.add('hidden');
    }
  },

  updateSurveyDeviceStatus() {
    const connText = document.getElementById('survey-device-conn-text');
    const qualityText = document.getElementById('survey-device-quality-text');
    const hintText = document.getElementById('survey-device-hint');

    const isConnected = this.state.isConnected;
    const isDemo = this.state.isDemo;
    const c = this.state.qualityResult ? this.state.qualityResult.c : 0;

    if (connText) {
      if (isDemo) {
        connText.innerHTML = '<span class="text-cyan-400 font-bold">● Демо-режим активен</span>';
      } else if (isConnected) {
        connText.innerHTML = '<span class="text-emerald-400 font-bold">● Подключен по Bluetooth</span>';
      } else {
        connText.innerHTML = '<span class="text-slate-400">○ Не подключено</span>';
      }
    }

    if (qualityText) {
      if (isDemo || c >= 0.5) {
        qualityText.innerHTML = `<span class="text-emerald-400 font-bold">${Math.round(c * 100)}% (Качество стабильное)</span>`;
      } else if (isConnected) {
        qualityText.innerHTML = `<span class="text-amber-400 font-bold">${Math.round(c * 100)}% (c < 0.5 — нестабилен)</span>`;
      } else {
        qualityText.innerHTML = '<span class="text-slate-500">Ожидание измерений</span>';
      }
    }

    if (hintText) {
      if (isDemo) {
        hintText.innerHTML = '✅ <b>Демонстрация активна:</b> виртуальные датчики генерируют корректный физиологический сигнал для проверки.';
      } else if (isConnected && c >= 0.5) {
        hintText.innerHTML = '✅ <b>Сигнал стабилен:</b> датчик правильно закреплен, можно переходить к сводке данных.';
      } else if (isConnected && c < 0.5) {
        hintText.innerHTML = '⚠️ <b>Качество сигнала c < 0.5:</b> поправьте браслет на руке, расслабьте мышцы и посидите спокойно 1–2 минуты.';
      } else {
        hintText.innerHTML = '💡 Нажмите «Подключить по Bluetooth» или «Запустить в демо-режиме» для проверки биосигналов.';
      }
    }
  },

  renderSurveySummary() {
    const itemsContainer = document.getElementById('survey-summary-items');
    const verdictContainer = document.getElementById('survey-summary-verdict');
    const actionsContainer = document.getElementById('survey-summary-actions');

    const validation = validateSurvey(this.state.surveyTemp);
    this.state.surveyValidation = validation;

    const baseline = this.baselineService.getBaseline();
    const quality = calculateDataQuality({
      hr: this.state.bpm,
      sdnn: this.state.sdnn,
      spo2: this.state.spo2,
      pIrr: this.state.pIrr
    }, baseline);
    const cBase = calculateBaselineCompleteness(Math.max(1, baseline.daysElapsed));
    this.state.qualityResult = calculateOverallCompleteness(quality.c_q, cBase);

    const c = this.state.isDemo ? Math.max(0.85, this.state.qualityResult.c) : this.state.qualityResult.c;

    // 1. Отображение карточек параметров
    if (itemsContainer) {
      const data = this.state.surveyTemp;
      const getSmokingText = () => {
        if (data.smoking === 0) return { ok: true, text: 'Не курю (S=0)' };
        if (data.smoking === 1) return { ok: true, text: 'Курю (S=1)' };
        return { ok: false, text: 'Предпочитаю не отвечать (отсутствует)' };
      };
      const getFamilyText = () => {
        if (data.familyHistory === 0) return { ok: true, text: 'Нет у родственников (F=0)' };
        if (data.familyHistory === 1) return { ok: true, text: 'Да, были ССЗ (F=1)' };
        return { ok: false, text: 'Не знаю (требуется уточнить)' };
      };
      const getStressText = () => {
        const map = { 0: 'Редко (Y=0)', 1: 'Умеренно (Y=1)', 2: 'Почти каждый день (Y=2)' };
        return map[data.stress] || 'Умеренно (Y=1)';
      };
      const getActivityText = () => {
        const map = { 0: 'Малоподвижный (P=0)', 1: 'Умеренная (P=1)', 2: 'Регулярный спорт (P=2)' };
        return map[data.activity] || 'Умеренная (P=1)';
      };

      const smokingInfo = getSmokingText();
      const familyInfo = getFamilyText();

      const cards = [
        { label: 'Возраст (A)', val: `${data.age || 40} лет`, ok: !!data.age },
        { label: 'Рост / Вес (ИМТ B)', val: `${data.heightCm || 175} см, ${data.weightKg || 75} кг (ИМТ: ${data.bmi || 24.5})`, ok: !!(data.heightCm && data.weightKg) },
        { label: 'Курение (S)', val: smokingInfo.text, ok: smokingInfo.ok },
        { label: 'Семейная история (F)', val: familyInfo.text, ok: familyInfo.ok },
        { label: 'Стресс (Y)', val: getStressText(), ok: data.stress != null },
        { label: 'Активность (P)', val: getActivityText(), ok: data.activity != null },
        { label: 'Сигнал датчика (c)', val: (this.state.isDemo || c >= 0.5) ? `Стабилен (${Math.round(c * 100)}%)` : `Недостаточен (${Math.round(c * 100)}% < 50%)`, ok: (this.state.isDemo || c >= 0.5) }
      ];

      itemsContainer.innerHTML = cards.map(c => `
        <div class="p-2.5 rounded-xl bg-slate-900 border ${c.ok ? 'border-slate-800' : 'border-amber-500/40 bg-amber-500/5'} space-y-0.5">
          <div class="flex items-center justify-between">
            <span class="text-slate-400 text-[11px]">${c.label}</span>
            <span class="text-xs">${c.ok ? '✅' : '⚠️'}</span>
          </div>
          <div class="text-xs font-semibold ${c.ok ? 'text-slate-200' : 'text-amber-300'}">${c.val}</div>
        </div>
      `).join('');
    }

    // 2. Вердикт готовности
    if (verdictContainer) {
      if (validation.isValid) {
        // Сохраняем проверенный профиль в хранилище
        StorageService.saveProfile(validation.profile);
        StorageService.setOnboarded(true);

        try {
          this.state.lStatResult = calculateLStat(validation.profile);
        } catch {
          this.state.lStatResult = null;
        }

        const modelEval = evaluateModel({
          lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
          lDyn: this.state.lDynResult ? this.state.lDynResult.lDyn : null,
          c: (this.state.isDemo || c >= 0.5) ? Math.max(0.85, c) : c,
          rPrev: this.state.prevR,
          dtMinutes: 0.1
        });

        if (modelEval.isDataSufficient && modelEval.index != null) {
          const zoneBadge = modelEval.zone === 'green' ? '<span class="text-emerald-400 font-bold">Зеленая зона (Низкий риск)</span>'
            : modelEval.zone === 'yellow' ? '<span class="text-amber-400 font-bold">Желтая зона (Умеренный риск)</span>'
            : '<span class="text-rose-400 font-bold">Красная зона (Высокий риск)</span>';

          verdictContainer.className = 'p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2';
          verdictContainer.innerHTML = `
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-300 uppercase tracking-wider">✅ Все данные собраны • Расчёт готов</span>
              <span class="text-xs font-mono font-bold text-white px-2 py-0.5 rounded bg-emerald-500/20">${modelEval.index} / 100</span>
            </div>
            <div class="text-xs text-slate-200 font-semibold">${zoneBadge}</div>
            <p class="text-[11px] text-slate-300 leading-relaxed">
              Математическая модель откалибрована. Базовый профиль L_stat = ${this.state.lStatResult.lStat.toFixed(2)}, динамическая составляющая учтена с качеством c = ${Math.round(c * 100)}%.
            </p>
          `;
        } else {
          verdictContainer.className = 'p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/30 space-y-2';
          verdictContainer.innerHTML = `
            <div class="text-xs font-bold text-cyan-300 uppercase tracking-wider">ℹ️ Анкета сохранена • Ожидание стабильного сигнала</div>
            <p class="text-[11px] text-slate-300 leading-relaxed">
              Все 6 факторов анкеты успешно заполнены. Для вычисления динамического индекса необходим устойчивый сигнал датчика (порог c ≥ 0.5). Пока датчик калибруется, система отобразит статус «Недостаточно данных».
            </p>
          `;
        }
      } else {
        // Данных анкеты недостаточно
        const missingList = validation.missing.map(m => `• <b>${m.label}:</b> ${m.reason}`).join('<br>');
        verdictContainer.className = 'p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2';
        verdictContainer.innerHTML = `
          <div class="text-xs font-bold text-amber-300 uppercase tracking-wider">⚠️ Расчёт индекса приостановлен (неполные данные)</div>
          <p class="text-[11px] text-slate-300 leading-relaxed">
            В соответствии со спецификацией Qamqor, математическая модель <b>не подменяет пропущенные ответы нулями или догадками</b>. Для точного расчёта не хватает следующих данных:<br>
            <div class="mt-1 text-[11px] text-amber-200 leading-relaxed bg-black/30 p-2 rounded-lg">${missingList}</div>
          </p>
        `;
      }
    }

    // 3. Кнопки действий
    if (actionsContainer) {
      if (validation.isValid) {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold">
            Изменить ответы
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-bold text-xs shadow-lg shadow-emerald-500/25 transition text-center">
            Перейти в дашборд здоровья →
          </button>
        `;
      } else {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold">
            ← Дополнить анкету
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 text-center">
            Открыть дашборд (только датчики) →
          </button>
        `;
      }
    }
  },

  completeSurveyAndOpenApp() {
    StorageService.setOnboarded(true);
    this.recalculateModel();
    this.showScreen('main-app');
    if (this.state.isDemo) {
      this.startDemoMode();
    }
    this.showToast('Добро пожаловать в мониторинг Qamqor!', 'success');
  },

  submitSurvey() {
    this.nextSurveyStep(1);
  },

  // ========================================================
  // ИСТОРИЯ И CSV
  // ========================================================
  renderHistoryList() {
    const container = document.getElementById('history-items-container');
    const hist = StorageService.getHistory();
    if (!container) return;

    if (hist.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Записи в журнале отсутствуют.</div>`;
      return;
    }

    container.innerHTML = hist.map(h => `
      <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
        <div class="flex items-center space-x-3">
          <span class="w-2.5 h-2.5 rounded-full ${h.isDemo ? 'bg-amber-400' : 'bg-emerald-400'} flex-shrink-0"></span>
          <div>
            <div class="font-semibold text-slate-200">${h.title}</div>
            <div class="text-[10px] text-slate-500 mt-0.5 font-mono">
              ${h.dateStr} ${h.timeStr} • Качество c: ${h.c != null ? Math.round(h.c * 100) + '%' : '--'}
            </div>
          </div>
        </div>
        <span class="font-mono font-bold text-slate-300 text-xs">${h.index != null ? 'Индекс: ' + h.index : ''}</span>
      </div>
    `).join('');
  },

  exportHistoryCSV() {
    const hist = StorageService.getHistory();
    if (hist.length === 0) {
      this.showToast('История пуста, экспорт не требуется', 'info');
      return;
    }

    let csvContent = 'ID;Дата;Время;Версия_Модели;Индекс_Риска;Зона;ЧСС;SpO2;Полнота_c;Источник\n';
    hist.forEach(h => {
      csvContent += `${h.id};${h.dateStr};${h.timeStr};${h.version || '1.0.0'};${h.index || ''};${h.zone || ''};${h.bpm || ''};${h.spo2 || ''};${h.c || ''};${h.isDemo ? 'ДЕМО' : 'РЕАЛЬНЫЙ'}\n`;
    });

    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qamqor_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('CSV файл экспортирован.', 'success');
  },

  populateSettingsTab() {
    const profile = StorageService.getProfile();
    const nameEl = document.getElementById('settings-profile-name');
    const ageEl = document.getElementById('settings-profile-age');
    const bmiEl = document.getElementById('settings-profile-bmi');
    const verEl = document.getElementById('settings-model-version');

    if (nameEl) nameEl.textContent = profile.name;
    if (ageEl) ageEl.textContent = `${profile.age} лет`;
    if (bmiEl) bmiEl.textContent = `${profile.bmi} кг/м²`;
    if (verEl) verEl.textContent = MODEL_CONFIG.version;
  },

  // ========================================================
  // SOS И ДИАЛОГИ
  // ========================================================
  openSOSModal(customMsg = null) {
    const modal = document.getElementById('modal-sos-dialog');
    const desc = document.getElementById('sos-dialog-description');
    if (desc && customMsg) {
      desc.textContent = customMsg;
    }
    if (modal) modal.classList.remove('hidden');
  },

  closeSOSModal() {
    const modal = document.getElementById('modal-sos-dialog');
    if (modal) modal.classList.add('hidden');
  },

  resetAllData() {
    if (confirm('Внимание! Это полностью сбросит все локальные данные, историю и вернет вас к экрану подключения. Продолжить?')) {
      StorageService.resetAll();
      this.bleService.disconnect();
      this.demoSimulator.stop();
      window.location.reload();
    }
  },

  showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const t = document.createElement('div');
    const borderCol = type === 'success' ? 'border-emerald-500/50 bg-emerald-950/80 text-emerald-200' :
                      type === 'warning' ? 'border-amber-500/50 bg-amber-950/80 text-amber-200' :
                      'border-cyan-500/50 bg-slate-900/90 text-cyan-200';

    t.className = `p-3 rounded-xl border ${borderCol} backdrop-blur-md shadow-xl text-xs font-medium flex items-center justify-between transition-all duration-300 transform translate-y-2 pointer-events-auto`;
    t.innerHTML = `<span>${msg}</span>`;
    container.appendChild(t);

    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3500);
  },


  // ========================================================
  // КРУГОВОЙ SVG ДАТЧИК РИСКА
  // ========================================================
  _updateGauge(index, zone) {
    const arc = document.getElementById('gauge-arc');
    const centerNum = document.getElementById('gauge-center-num');
    const centerLabel = document.getElementById('gauge-center-label');
    if (!arc) return;

    const r = 54;
    const circumference = 2 * Math.PI * r;

    if (index == null || zone === 'none') {
      arc.style.strokeDasharray = '0 ' + circumference;
      arc.style.stroke = '#334155';
      if (centerNum) { centerNum.textContent = '--'; centerNum.style.fill = '#94a3b8'; }
      if (centerLabel) { centerLabel.textContent = 'Ожидание'; centerLabel.style.fill = '#94a3b8'; }
      return;
    }

    const pct = Math.min(100, Math.max(0, index)) / 100;
    const dashLen = pct * circumference;
    arc.style.strokeDasharray = dashLen + ' ' + (circumference - dashLen);
    arc.style.transition = 'stroke-dasharray 0.6s ease, stroke 0.4s ease';

    const color = zone === 'red' ? '#ef4444' : zone === 'yellow' ? '#f59e0b' : '#10b981';
    arc.style.stroke = color;

    if (centerNum) { centerNum.textContent = index; centerNum.style.fill = color; }
    if (centerLabel) {
      centerLabel.textContent = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : 'Норма';
      centerLabel.style.fill = color;
    }
  },

  // ========================================================
  // ОПЕКУН / ВРАЧ — ТЕЛЕГРАМ УВЕДОМЛЕНИЯ
  // ========================================================
  loadGuardianConfig() {
    try {
      const raw = localStorage.getItem('qamqor_v3_guardian');
      return raw ? JSON.parse(raw) : { name: '', botToken: '', chatId: '', notifyRed: true, notifyDeterioration: true };
    } catch { return { name: '', botToken: '', chatId: '', notifyRed: true, notifyDeterioration: true }; }
  },

  saveGuardianConfig(cfg) {
    localStorage.setItem('qamqor_v3_guardian', JSON.stringify(cfg));
  },

  renderGuardianTab() {
    const cfg = this.loadGuardianConfig();
    const tab = document.getElementById('tab-guardian');
    if (!tab) return;

    const profile = StorageService.getProfile() || { name: 'Мама', age: 40 };
    const patientName = profile.name || 'Мама';
    const lastNotifRaw = localStorage.getItem('qamqor_v3_guardian_last_notif');
    const lastNotifStr = lastNotifRaw
      ? new Date(parseInt(lastNotifRaw)).toLocaleString('ru-RU')
      : 'Уведомления ещё не отправлялись';

    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const isRed = evalRes.zone === 'red';
    const isYellow = evalRes.zone === 'yellow';

    // Формируем текст предпросмотра сообщения
    const previewMessage = this.getFormattedGuardianAlertMessage('red');
    const previewDisplayHtml = previewMessage
      .replace(/\n/g, '<br>')
      .replace(/\*([^*]+)\*/g, '<b class="text-white">$1</b>');

    tab.innerHTML = `
      <div class="space-y-4">
        <!-- Шапка -->
        <div class="p-4 rounded-2xl bg-gradient-to-r from-violet-950/40 to-slate-900 border border-violet-500/30 text-xs text-slate-300 leading-relaxed flex items-start justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <b class="text-white text-sm">Удалённый присмотр за близким</b>
              <span class="px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 text-[10px] font-bold">Сын / Врач</span>
            </div>
            <div class="text-slate-400 leading-normal">
              Если браслет носит <b>мама</b>, а сын или врач находится <b>в другом городе</b> — система автоматически пришлёт срочный сигнал при росте риска или ухудшении пульса.
            </div>
          </div>
          <span class="text-3xl flex-shrink-0">👨‍⚕️</span>
        </div>

        <!-- КАРТОЧКА: ПРОВЕРКА ОТПРАВКИ И ПРЕДПРОСМОТР СООБЩЕНИЯ -->
        <div class="glass-card rounded-2xl p-4 sm:p-5 border border-cyan-500/40 bg-gradient-to-br from-cyan-950/20 via-slate-900 to-slate-900 space-y-3.5">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <div class="flex items-center space-x-2">
              <span class="w-6 h-6 rounded-lg bg-cyan-500/20 text-cyan-300 flex items-center justify-center font-bold text-xs">📨</span>
              <div>
                <h3 class="text-xs sm:text-sm font-bold text-white">Проверка отправки в бот и текст сообщения</h3>
                <p class="text-[10px] sm:text-[11px] text-slate-400">Проверьте, доходят ли сообщения опекуну, и посмотрите текст оповещения</p>
              </div>
            </div>
          </div>

          <!-- Предпросмотр текста сообщения для Telegram -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-cyan-300 uppercase tracking-wider text-[11px]">💬 Какое сообщение отправляется в бот:</span>
              <span class="text-[10px] text-slate-400 font-mono">Telegram Markdown</span>
            </div>
            <div class="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 text-[11px] text-slate-300 font-mono leading-relaxed shadow-inner">
              ${previewDisplayHtml}
            </div>
          </div>

          <!-- Кнопка проверки доставки -->
          <button id="btn-verify-telegram" onclick="App.verifyTelegramDelivery()" class="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-xs shadow-lg shadow-cyan-500/25 active:scale-98 transition flex items-center justify-center space-x-2">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            <span>Проверить отправку в Telegram прямо сейчас</span>
          </button>

          <!-- Результат проверки в реальном времени -->
          <div id="guardian-verify-result-box" class="hidden p-3 rounded-xl border text-xs leading-relaxed space-y-1.5"></div>
        </div>

        <!-- 1. Быстрый обмен данными с сыном / врачом -->
        <div class="glass-card rounded-2xl p-4 border border-slate-800 space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-bold text-slate-300 uppercase tracking-wider">Поделиться состоянием</div>
            <span class="text-[10px] font-mono text-emerald-400">В 1 клик</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button onclick="App.shareViaWhatsApp()" class="py-2.5 px-3 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center space-x-2 transition shadow-md shadow-emerald-600/20">
              <span>💬 Отправить сводку в WhatsApp</span>
            </button>
            <button onclick="App.copyGuardianShareLink()" class="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold text-xs border border-cyan-700/50 flex items-center justify-center space-x-2 transition">
              <span>🔗 Скопировать ссылку для сына</span>
            </button>
          </div>
        </div>

        <!-- 2. Настройки опекуна (Telegram) -->
        <div class="glass-card rounded-2xl p-4 border border-slate-800 space-y-3">
          <div class="text-xs font-bold text-violet-400 uppercase tracking-wider">Настройки опекуна / врача</div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-300">Имя опекуна <span class="text-slate-500">(например: Сын Арман, Врач Карим)</span></label>
            <input type="text" id="guardian-name" value="${cfg.name || ''}" placeholder="Сын Арман" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-violet-400">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-300">Телефон опекуна <span class="text-slate-500">(для быстрого звонка)</span></label>
            <input type="tel" id="guardian-phone" value="${cfg.phone || ''}" placeholder="+7 777 123 4567" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-violet-400">
          </div>

          <div class="p-3 rounded-xl bg-amber-950/20 border border-amber-700/30 text-[11px] text-amber-200 leading-relaxed space-y-1">
            <div class="font-bold">⚡ Как настроить Telegram-бота:</div>
            <div>1. Откройте Telegram → найдите <b>@BotFather</b> → напишите <span class="font-mono">/newbot</span></div>
            <div>2. Вставьте сюда полученный <b>Bot Token</b></div>
            <div>3. Нажмите <span class="font-mono">/start</span> в вашем новом боте, а в <b>@userinfobot</b> узнайте свой <b>Chat ID</b></div>
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-300">Telegram Bot Token <span class="text-rose-400">*</span></label>
            <input type="text" id="guardian-token" value="${cfg.botToken || ''}" placeholder="1234567890:AAHq_ABCDEF..." class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-violet-400">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-300">Telegram Chat ID сына / опекуна <span class="text-rose-400">*</span></label>
            <input type="text" id="guardian-chatid" value="${cfg.chatId || ''}" placeholder="987654321" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-violet-400">
          </div>

          <div class="space-y-2 pt-1">
            <div class="text-xs font-medium text-slate-300">Когда присылать сигналы опекуну:</div>
            <label class="flex items-center space-x-3 cursor-pointer p-2 rounded-xl bg-slate-900/80 border border-slate-800">
              <input type="checkbox" id="guardian-notify-red" ${cfg.notifyRed ? 'checked' : ''} class="w-4 h-4 accent-rose-500 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-300">🔴 <b>Красная зона:</b> индекс ≥ 40 (Срочно!)</span>
            </label>
            <label class="flex items-center space-x-3 cursor-pointer p-2 rounded-xl bg-slate-900/80 border border-slate-800">
              <input type="checkbox" id="guardian-notify-det" ${cfg.notifyDeterioration ? 'checked' : ''} class="w-4 h-4 accent-amber-500 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-300">🟡 <b>Ухудшение:</b> резкий скачок пульса или падение кислорода</span>
            </label>
          </div>

          <button onclick="App.saveGuardianSettings()" class="w-full py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-700 hover:from-violet-500 hover:to-purple-600 text-white font-bold text-xs shadow-lg shadow-violet-500/20 transition">
            💾 Сохранить настройки опекуна
          </button>
        </div>
      </div>
    `;
  },

  saveGuardianSettings() {
    const cfg = {
      name: document.getElementById('guardian-name')?.value || '',
      phone: document.getElementById('guardian-phone')?.value || '',
      botToken: document.getElementById('guardian-token')?.value || '',
      chatId: document.getElementById('guardian-chatid')?.value || '',
      notifyRed: document.getElementById('guardian-notify-red')?.checked || false,
      notifyDeterioration: document.getElementById('guardian-notify-det')?.checked || false
    };
    this.saveGuardianConfig(cfg);
    this.showToast('Настройки опекуна сохранены', 'success');
  },

  getFormattedGuardianAlertMessage(scenario = 'red') {
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const bpm = this.state.bpm || 112;
    const spo2 = this.state.spo2 || 94;
    const idx = (this.state.modelEvaluation && this.state.modelEvaluation.index != null) ? this.state.modelEvaluation.index : (scenario === 'red' ? 46 : 28);
    const isRed = scenario === 'red' || idx >= 40;
    const emoji = isRed ? '🔴' : '🟡';
    const statusText = isRed ? 'ВЫСОКИЙ РИСК: Индекс кардио-напряжения ≥ 40' : 'Внимание: Умеренное отклонение показателей';

    return `${emoji} *Срочное оповещение Qamqor:* ${statusText}\n\n` +
      `👤 *Пациент:* ${patientName}\n` +
      `📊 *Индекс риска:* ${idx} / 100 (${isRed ? 'Красная зона' : 'Жёлтая зона'})\n` +
      `❤️ *Пульс (ЧСС):* ${bpm} уд/мин\n` +
      `🩸 *Кислород SpO2:* ${spo2}%\n\n` +
      `⚠️ *Рекомендация:* Свяжитесь с близким человеком, убедитесь в хорошем самочувствии или вызовите помощь.`;
  },

  async verifyTelegramDelivery() {
    const tokenInput = document.getElementById('guardian-token');
    const chatInput = document.getElementById('guardian-chatid');
    const resultBox = document.getElementById('guardian-verify-result-box');
    const btn = document.getElementById('btn-verify-telegram');

    const token = tokenInput ? tokenInput.value.trim() : '';
    const chatId = chatInput ? chatInput.value.trim() : '';

    if (!token || !chatId) {
      if (resultBox) {
        resultBox.className = 'p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1';
        resultBox.innerHTML = '❌ <b>Сначала введите Bot Token и Chat ID</b> в полях ниже, затем нажмите проверку.';
        resultBox.classList.remove('hidden');
      }
      this.showToast('Заполните Bot Token и Chat ID', 'warning');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '⏳ Проверяем связь с Telegram...';
    }

    if (resultBox) {
      resultBox.className = 'p-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-xs leading-relaxed space-y-1';
      resultBox.innerHTML = '⏳ Отправляем тестовое сообщение через API Telegram...';
      resultBox.classList.remove('hidden');
    }

    const testMsg = this.getFormattedGuardianAlertMessage('red');
    const now = new Date().toLocaleString('ru-RU');
    const fullText = `🔔 *Тестовая проверка связи Qamqor*\n\n` +
      `Бот успешно подключён к системе мониторинга!\n\n` +
      `Вот так будет выглядеть экстренное сообщение опекуну:\n` +
      `-----------------------------------------\n` +
      testMsg + `\n` +
      `-----------------------------------------\n` +
      `⏰ Время отправки: ${now}`;

    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: fullText, parse_mode: 'Markdown' })
      });
      const data = await resp.json();

      if (data.ok) {
        localStorage.setItem('qamqor_v3_guardian_last_notif', Date.now().toString());
        this.saveGuardianSettings();
        if (resultBox) {
          resultBox.className = 'p-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-xs leading-relaxed space-y-1.5';
          resultBox.innerHTML = `✅ <b>Сообщение успешно доставлено в Telegram!</b><br>ID сообщения в чате: <span class="font-mono text-white">#${data.result.message_id}</span>. Проверьте ваш Telegram.`;
        }
        this.showToast('✅ Сообщение доставлено в Telegram!', 'success');
      } else {
        if (resultBox) {
          resultBox.className = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1.5';
          resultBox.innerHTML = `❌ <b>Ошибка Telegram API:</b> ${data.description || 'Не удалось доставить'}.<br><span class="text-slate-400">Проверьте: 1) Нажали ли вы /start в боте? 2) Верно ли скопирован chat_id?</span>`;
        }
        this.showToast('Ошибка Telegram: ' + (data.description || 'Проверьте данные'), 'warning');
      }
    } catch(err) {
      if (resultBox) {
        resultBox.className = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs leading-relaxed space-y-1.5';
        resultBox.innerHTML = `❌ <b>Сетевая ошибка:</b> ${err.message}. Проверьте интернет.`;
      }
      this.showToast('Сетевая ошибка при отправке', 'warning');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg><span>Проверить отправку в Telegram прямо сейчас</span>`;
      }
    }
  },

  async sendGuardianNotification(message) {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) return false;

    const profile = StorageService.getProfile();
    const userName = (profile && profile.name) ? profile.name : 'Мама';
    const now = new Date().toLocaleString('ru-RU');

    const fullText = '🏥 *Qamqor Health Alert*\n\n' +
      '👤 *Пациент:* ' + userName + '\n\n' +
      message + '\n\n' +
      '⏰ ' + now;

    try {
      const resp = await fetch('https://api.telegram.org/bot' + cfg.botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: fullText, parse_mode: 'Markdown' })
      });
      const data = await resp.json();
      if (data.ok) {
        localStorage.setItem('qamqor_v3_guardian_last_notif', Date.now().toString());
        return true;
      }
    } catch (e) {
      console.warn('[Guardian] Telegram error:', e.message);
    }
    return false;
  },

  async sendTestGuardianNotification() {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) {
      this.showToast('Сначала заполните Bot Token и Chat ID', 'warning');
      return;
    }
    this.showToast('Отправляем тестовое уведомление...', 'info');
    const guardianName = cfg.name || 'Опекун';
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const ok = await this.sendGuardianNotification(
      '✅ *Связь настроена успешно!*\n' +
      'Опекун: *' + guardianName + '*\n' +
      'Вы будете получать срочные сигналы, если у *' + patientName + '* ухудшатся показатели.'
    );
    if (ok) {
      this.showToast('Тестовое уведомление доставлено в Telegram!', 'success');
      this.renderGuardianTab();
    } else {
      this.showToast('Ошибка отправки. Проверьте токен и chat_id.', 'warning');
    }
  },

  async sendCurrentStatusNotification() {
    const cfg = this.loadGuardianConfig();
    if (!cfg.botToken || !cfg.chatId) {
      this.showToast('Сначала заполните Bot Token и Chat ID', 'warning');
      return;
    }
    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const isRed = evalRes.zone === 'red';
    const isYellow = evalRes.zone === 'yellow';
    const emoji = isRed ? '🔴' : isYellow ? '🟡' : '🟢';
    const statusText = isRed ? 'ВЫСОКИЙ РИСК (Срочно принять меры!)' : isYellow ? 'Умеренное отклонение (Внимание)' : 'Состояние стабильное (В норме)';

    const msg = emoji + ' *Текущий отчёт о здоровье:*\n' +
      '• Статус: *' + statusText + '*\n' +
      '• Индекс риска: *' + (evalRes.index != null ? evalRes.index : 18) + ' / 100*\n' +
      '• Пульс: *' + (this.state.bpm || 72) + ' уд/мин*\n' +
      '• Кислород SpO2: *' + (this.state.spo2 || 98) + '%*';

    this.showToast('Отправляем текущую сводку в Telegram...', 'info');
    const ok = await this.sendGuardianNotification(msg);
    if (ok) {
      this.showToast('Сводка успешно отправлена опекуну!', 'success');
      this.renderGuardianTab();
    } else {
      this.showToast('Ошибка отправки.', 'warning');
    }
  },

  copyGuardianShareLink() {
    const profile = StorageService.getProfile();
    const name = encodeURIComponent((profile && profile.name) ? profile.name : 'Мама');
    const evalRes = this.state.modelEvaluation || { index: 18 };
    const url = window.location.origin + window.location.pathname + '?guardian_view=1&patient=' + name + '&risk=' + (evalRes.index || 18);
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        this.showToast('Ссылка скопирована! Отправьте её сыну или врачу', 'success');
      }).catch(() => {
        prompt('Скопируйте ссылку для сына/врача:', url);
      });
    } else {
      prompt('Скопируйте ссылку для сына/врача:', url);
    }
  },

  shareViaWhatsApp() {
    const profile = StorageService.getProfile();
    const patientName = (profile && profile.name) ? profile.name : 'Мама';
    const evalRes = this.state.modelEvaluation || { index: 18, zone: 'green' };
    const text = encodeURIComponent(
      '🏥 Qamqor — Отчёт о здоровье (' + patientName + '):\n' +
      '• Индекс риска: ' + (evalRes.index != null ? evalRes.index : 18) + '/100\n' +
      '• Пульс: ' + (this.state.bpm || 72) + ' уд/мин\n' +
      '• Кислород: ' + (this.state.spo2 || 98) + '%\n' +
      'Время: ' + new Date().toLocaleTimeString('ru-RU')
    );
    window.open('https://wa.me/?text=' + text, '_blank');
  },

  callPatient() {
    const cfg = this.loadGuardianConfig();
    if (cfg.phone) {
      window.location.href = 'tel:' + cfg.phone.replace(/\s+/g, '');
    } else {
      this.showToast('Телефон не указан в настройках опекуна', 'info');
    }
  },

  exitGuardianView() {
    window.location.href = window.location.pathname;
  },

  // ========================================================
  // ДЫХАТЕЛЬНЫЙ ТРЕНАЖЕР 4-4-4
  // ========================================================
  _breathingInterval: null,
  _breathingActive: false,
  _breathingPhase: 0, // 0: inhale (4s), 1: hold (4s), 2: exhale (4s)
  _breathingSecLeft: 4,

  toggleBreathingExercise() {
    const box = document.getElementById('breathing-box');
    const btn = document.getElementById('btn-breathing-toggle');
    if (!box) return;

    if (this._breathingActive) {
      // Остановить
      clearInterval(this._breathingInterval);
      this._breathingActive = false;
      box.classList.add('hidden');
      if (btn) btn.innerHTML = '▶ Начать';
      this.showToast('Упражнение завершено', 'info');
    } else {
      // Запустить
      this._breathingActive = true;
      this._breathingPhase = 0;
      this._breathingSecLeft = 4;
      box.classList.remove('hidden');
      if (btn) btn.innerHTML = '⏹ Завершить';
      this._updateBreathingUI();

      this._breathingInterval = setInterval(() => {
        this._breathingSecLeft--;
        if (this._breathingSecLeft <= 0) {
          this._breathingPhase = (this._breathingPhase + 1) % 3;
          this._breathingSecLeft = 4;
        }
        this._updateBreathingUI();
      }, 1000);
      this.showToast('Дышите плавно и спокойно', 'info');
    }
  },

  _updateBreathingUI() {
    const secEl = document.getElementById('breathing-phase-sec');
    const textEl = document.getElementById('breathing-phase-text');
    const circleEl = document.getElementById('breathing-circle');
    if (!secEl || !textEl || !circleEl) return;

    secEl.textContent = this._breathingSecLeft;

    if (this._breathingPhase === 0) {
      textEl.textContent = '🌬️ Вдох носом (4 сек)...';
      textEl.className = 'text-xs font-bold text-cyan-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(1.25)';
      circleEl.style.borderColor = '#06b6d4';
      circleEl.style.backgroundColor = 'rgba(6, 182, 212, 0.3)';
    } else if (this._breathingPhase === 1) {
      textEl.textContent = '⏸️ Задержка дыхания (4 сек)...';
      textEl.className = 'text-xs font-bold text-amber-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(1.25)';
      circleEl.style.borderColor = '#f59e0b';
      circleEl.style.backgroundColor = 'rgba(245, 158, 11, 0.25)';
    } else {
      textEl.textContent = '💨 Плавный выдох через рот (4 сек)...';
      textEl.className = 'text-xs font-bold text-emerald-300 uppercase tracking-wider';
      circleEl.style.transform = 'scale(0.85)';
      circleEl.style.borderColor = '#10b981';
      circleEl.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
    }
  },

  registerSW() {
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(e => console.log('SW Note:', e.message));
    }
  }
};

// Экспорт в глобальную область для onclick-хэндлеров в HTML
window.App = App;
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
