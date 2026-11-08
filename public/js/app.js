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
    deviceState: 'disconnected',         // 'disconnected' | 'connected_no_data' | 'connected_receiving' | 'connection_lost'
    deviceName: 'Qamqor Band',

    // Текущие биометрические показатели (в реальном режиме по умолчанию null!)
    bpm: null,
    spo2: null,
    sdnn: null,
    pIrr: null,
    lastUpdateTime: null,
    lastTelemetryTimestamp: 0,

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

    // Проверка статуса онбординга и режима работы
    if (StorageService.isOnboarded()) {
      this.showScreen('main-app');
      if (StorageService.isDemoMode()) {
        this.startDemoMode();
      } else {
        this.setRealDeviceMode();
      }
    } else {
      // Сначала показываем анкету, потом уже подключение
      this.showScreen('onboarding-survey');
      this.goToSurveyStep(1);
    }

    // Сторожевой таймер активности реальных датчиков (Watchdog)
    setInterval(() => {
      if (this.state.isConnected && !this.state.isDemo) {
        if (this.state.lastTelemetryTimestamp > 0 && Date.now() - this.state.lastTelemetryTimestamp > 4500) {
          if (this.state.deviceState === 'connected_receiving') {
            console.log('[BLE Watchdog] Поток измерений прекращен, переключение в connected_no_data');
            this.state.deviceState = 'connected_no_data';
            this.state.bpm = null;
            this.state.spo2 = null;
            this.updateConnectionUI();
            this.recalculateModel();
            this.renderDashboardMetrics();
          }
        }
      }
    }, 2000);

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
        this.ecgCanvas.setStreamActive(true, this.state.isDemo);
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
    if (!tabId) return;
    tabId = tabId.replace(/^tab-/, '');
    this.state.activeTab = tabId;
    const tabs = ['home', 'metrics', 'factors', 'history', 'settings', 'guardian'];

    tabs.forEach(t => {
      const sec = document.getElementById(`tab-${t}`);
      const btn = document.getElementById(`nav-btn-${t}`);
      const sbtn = document.getElementById(`sidebar-btn-${t}`);
      const isActive = (t === tabId);

      if (sec) {
        if (isActive) {
          sec.classList.remove('hidden');
          sec.style.display = 'block';
        } else {
          sec.classList.add('hidden');
          sec.style.display = 'none';
        }
      }

      // Mobile Bottom Nav Button Styling (Light Theme)
      if (btn) {
        if (isActive) {
          btn.className = 'flex flex-col items-center justify-center py-1.5 px-0.5 rounded-xl text-teal-700 font-semibold text-[10px] transition bg-teal-50/80';
        } else {
          btn.className = 'flex flex-col items-center justify-center py-1.5 px-0.5 rounded-xl text-slate-500 font-medium text-[10px] transition hover:text-slate-900';
        }
      }

      // Desktop Sidebar Button Styling (Light Theme)
      if (sbtn) {
        if (isActive) {
          sbtn.className = 'flex items-center space-x-3 w-full px-3.5 py-2.5 rounded-xl bg-teal-50 text-teal-800 font-semibold text-xs border border-teal-200/60 shadow-sm transition';
        } else {
          sbtn.className = 'flex items-center space-x-3 w-full px-3.5 py-2.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-50 text-xs font-medium transition';
        }
      }
    });

    try {
      if (tabId === 'history') {
        this.renderHistoryList();
        this.renderRecommendationsTab();
      } else if (tabId === 'factors') {
        this.renderFactorsTab();
      } else if (tabId === 'guardian') {
        this.renderGuardianTab();
      } else if (tabId === 'settings') {
        this.populateSettingsTab();
      } else if (tabId === 'home' || tabId === 'metrics') {
        if (this.ecgCanvas) {
          this.ecgCanvas.setStreamActive(this.state.isDemo || this.state.isConnected, this.state.isDemo);
        }
      }
    } catch(err) {
      console.warn('Error rendering tab content:', tabId, err);
    }

    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch(e) {}
  },

  // ========================================================
  // ОБРАБОТКА ПОСТУПЛЕНИЯ ДАННЫХ И СОСТОЯНИЙ BLE
  // ========================================================
  handleBLETelemetry(data) {
    // При поступлении реальных данных принудительно отключаем демо-режим
    if (this.state.isDemo) {
      this.demoSimulator.stop();
      this.state.isDemo = false;
      StorageService.setDemoMode(false);
    }

    if (data.hasValidSensors) {
      this.state.deviceState = 'connected_receiving';
      this.state.lastTelemetryTimestamp = Date.now();
      if (data.bpm != null && data.bpm > 0) this.state.bpm = data.bpm;
      if (data.spo2 != null && data.spo2 > 0) this.state.spo2 = data.spo2;

      // Если пользователь ещё на экране анкеты/проверки датчика, сразу переводим в дашборд с реальными данными!
      if (this.state.currentScreen === 'onboarding-survey') {
        this.completeSurveyAndOpenApp();
      }

      // Сохраняем только валидные замеры (receiving, пульс 40-200, SpO2 70-100) не чаще раза в 5 секунд
      const isPhysiologicalData = (
        data.status === 'receiving' &&
        typeof this.state.bpm === 'number' && this.state.bpm >= 40 && this.state.bpm <= 200 &&
        typeof this.state.spo2 === 'number' && this.state.spo2 >= 70 && this.state.spo2 <= 100
      );

      if (isPhysiologicalData && (!this._lastHistSavedAt || Date.now() - this._lastHistSavedAt >= 5000)) {
        this._lastHistSavedAt = Date.now();
        const now = new Date();
        const histEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          timestamp: Date.now(),
          time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          date: now.toLocaleDateString('ru-RU'),
          bpm: this.state.bpm,
          spo2: this.state.spo2,
          sdnn: this.state.sdnn != null ? Math.round(this.state.sdnn) : '—',
          index: this.state.modelEvaluation ? this.state.modelEvaluation.index : '—',
          zone: this.state.modelEvaluation ? this.state.modelEvaluation.zone : 'green',
          source: 'Qamqor Band (MAX30102)'
        };
        try {
          const currentHist = StorageService.getHistory();
          currentHist.unshift(histEntry);
          if (currentHist.length > 500) currentHist.length = 500;
          StorageService.saveHistory(currentHist);
          this.renderRecentMeasurementsTable();
        } catch (saveErr) {
          console.warn('[Qamqor] Безопасная обработка сохранения истории:', saveErr);
        }
      }
    } else {
      if (this.state.isConnected) {
        this.state.deviceState = 'connected_no_data';
        this.state.bpm = null;
        this.state.spo2 = null;
      }
    }

    if (data.ecg != null && this.ecgCanvas) {
      this.ecgCanvas.pushRealSample(data.ecg);
    }
    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(this.state.isConnected, false);
      if (this.state.bpm) this.ecgCanvas.setBPM(this.state.bpm);
    }

    if (data.rrIntervals && data.rrIntervals.length >= 5) {
      try {
        this.state.sdnn = calculateSDNN(data.rrIntervals);
        this.state.pIrr = calculateRhythmIrregularity(data.rrIntervals);
      } catch(e) {
        console.warn('SDNN/pIrr calculation error:', e);
      }
    } else if (!data.hasValidSensors) {
      this.state.sdnn = null;
      this.state.pIrr = null;
    }

    this.recalculateModel();
    this.updateConnectionUI();
    this.renderDashboardMetrics();
    if (this.state.currentSurveyStep === 4) {
      this.updateSurveyDeviceStatus();
    }
  },

  handleBLEStatusChange(status) {
    this.state.isConnected = status.connected;
    if (status.status) {
      this.state.deviceState = status.status;
    }
    if (status.connected) {
      // При подключении реального устройства выходим из демо-режима
      if (this.state.isDemo) {
        this.demoSimulator.stop();
        this.state.isDemo = false;
        StorageService.setDemoMode(false);
      }
      if (!status.status) this.state.deviceState = 'connected_no_data';
      this.state.deviceName = status.deviceName || 'Qamqor_Band';
      if (!this._hasNotifiedConnect) {
        this.showToast(`Браслет ${this.state.deviceName} подключен. Загрузка данных на дашборд...`, 'success');
        this._hasNotifiedConnect = true;
      }
      if (this.ecgCanvas) {
        this.ecgCanvas.setStreamActive(true, false); // allowSynthetic = false
      }
    } else {
      this._hasNotifiedConnect = false;
      if (status.status === 'reconnecting') {
        this.state.deviceState = 'reconnecting';
        this.showToast(status.statusText || 'Соединение потеряно, переподключаюсь...', 'warning');
      } else {
        this.state.deviceState = (status.statusText && status.statusText.includes('потеряна')) ? 'connection_lost' : 'disconnected';
        this.clearBiometrics();
        this.showToast(status.statusText || 'Связь с браслетом разорвана', 'warning');
      }
      if (this.ecgCanvas) {
        this.ecgCanvas.setStreamActive(false, false);
      }
    }
    this.updateConnectionUI();
    this.recalculateModel();
    this.renderDashboardMetrics();
    if (this.state.currentSurveyStep === 4) {
      this.updateSurveyDeviceStatus();
    }
  },

  handleBLEError(err) {
    if (err.name !== 'NotFoundError') {
      this.showToast(`Ошибка BLE: ${err.message}`, 'warning');
    }
  },

  clearBiometrics() {
    this.state.bpm = null;
    this.state.spo2 = null;
    this.state.sdnn = null;
    this.state.pIrr = null;
    this.state.lastUpdateTime = null;
    this.state.lDynResult = null;
    this.state.modelEvaluation = null;
    this.state.qualityResult = null;
    if (this.ecgCanvas) {
      this.ecgCanvas.realECGQueue = [];
    }
  },

  setRealDeviceMode() {
    this.demoSimulator.stop();
    this.state.isDemo = false;
    StorageService.setDemoMode(false);
    this.clearBiometrics();
    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(this.state.isConnected, false);
    }
    this.updateConnectionUI();
    this.recalculateModel();
    this.renderDashboardMetrics();
    console.log('[Qamqor] Режим реального устройства активирован. Демо-данные очищены.');
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
    this.state.deviceState = 'disconnected';
    StorageService.setDemoMode(true);
    this.updateConnectionUI();

    if (this.ecgCanvas) {
      this.ecgCanvas.setStreamActive(true, true); // allowSynthetic = true
    }

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
    this.showToast('Демо-режим симулятора запущен.', 'info');
  },

  stopDemoMode() {
    this.setRealDeviceMode();
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

    // Если в реальном режиме нет данных с датчиков пульса/SpO2 — динамический расчёт невозможен
    if (!this.state.isDemo && (this.state.bpm == null || this.state.spo2 == null)) {
      this.state.lDynResult = null;
      this.state.qualityResult = { c_q: 0, c_base: 0, c: 0, percentage: 0, label: 'Ожидание измерений' };
      this.state.modelEvaluation = evaluateModel({
        lStat: this.state.lStatResult ? this.state.lStatResult.lStat : null,
        lDyn: null,
        c: 0
      });
      this.state.recommendations = [];
      this.state.improvementPlan = [];
      this.state.lastUpdateTime = null;
      this.renderDashboardMetrics();
      if (this.state.activeTab === 'factors') {
        this.renderFactorsTab();
      }
      return;
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
    let effectiveC = this.state.isDemo ? Math.max(0.85, this.state.qualityResult.c) : this.state.qualityResult.c;

    // Для реального устройства при активном потоке измерений (пульс и SpO2 валидны)
    // производим расчет динамического риска
    if (!this.state.isDemo && this.state.bpm != null && this.state.spo2 != null) {
      effectiveC = Math.max(0.70, effectiveC);
    }

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
    if (bpmVal) {
      bpmVal.textContent = this.state.isDemo 
        ? (this.state.bpm || '72') 
        : (this.state.bpm != null ? this.state.bpm : '—');
    }

    const spo2Val = document.getElementById('home-metric-spo2-val');
    if (spo2Val) {
      spo2Val.textContent = this.state.isDemo 
        ? `${this.state.spo2 || 98}%` 
        : (this.state.spo2 != null ? `${this.state.spo2}%` : '—');
    }

    // Проверка анкеты и качества данных c < 0.5
    const isSurveyValid = this.state.surveyValidation ? this.state.surveyValidation.isValid : false;
    const isQualitySufficient = this.state.isDemo || (this.state.qualityResult && this.state.qualityResult.c >= 0.5) || (!this.state.isDemo && this.state.bpm != null && this.state.spo2 != null);

    const numEl = document.getElementById('home-index-number');
    const barEl = document.getElementById('home-index-progress-bar');
    const zoneEl = document.getElementById('home-index-zone-label');
    const statusEl = document.getElementById('home-index-status-desc');

    if (!isSurveyValid) {
      if (numEl) numEl.innerHTML = '<span class="text-xl text-amber-600 font-bold">Анкета не завершена</span>';
      if (barEl) {
        barEl.style.width = '0%';
        barEl.className = 'bg-slate-200 h-2.5 rounded-full';
      }
      if (zoneEl) {
        zoneEl.textContent = 'Требуется завершить анкету';
        zoneEl.className = 'text-xs font-bold text-amber-700';
      }
      if (statusEl) {
        statusEl.innerHTML = '<button onclick="App.startSurveyWizard()" class="text-teal-700 font-semibold underline decoration-dotted hover:text-teal-800">Нажмите здесь, чтобы ответить на вопросы модели</button>';
      }
      this._updateGauge(null, 'none');
    } else if (!this.state.isDemo && (this.state.bpm == null || this.state.spo2 == null)) {
      // Реальный режим без активного контакта с датчиками
      if (numEl) numEl.innerHTML = '<span class="text-3xl text-slate-400 font-extrabold">—</span>';
      if (barEl) {
        barEl.style.width = '0%';
        barEl.className = 'bg-slate-200 h-2.5 rounded-full';
      }
      if (zoneEl) {
        zoneEl.textContent = this.state.deviceState === 'connected_no_data' ? 'Ожидание измерений' : 'Устройство не подключено';
        zoneEl.className = 'text-xs font-semibold text-slate-500';
      }
      if (statusEl) {
        statusEl.textContent = this.state.deviceState === 'connected_no_data'
          ? 'Браслет подключён по BLE. Закрепите браслет на запястье и коснитесь датчика MAX30102.'
          : 'Подключите браслет Qamqor по Bluetooth для сбора телеметрии.';
      }
      this._updateGauge(null, 'none');
    } else if (!isQualitySufficient) {
      // ПРАВИЛО 1 & 6: При c < 0.5 не показывать число как достоверный результат
      if (numEl) numEl.innerHTML = '<span class="text-2xl text-amber-600 font-bold">Недостаточно данных</span>';
      if (barEl) {
        barEl.style.width = '0%';
        barEl.className = 'bg-slate-200 h-2.5 rounded-full';
      }
      if (zoneEl) {
        zoneEl.textContent = 'Расчет приостановлен (c < 0.5)';
        zoneEl.className = 'text-xs font-bold text-amber-700';
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
        zoneEl.className = zone === 'red' ? 'text-xs font-bold text-rose-600' :
                           zone === 'yellow' ? 'text-xs font-bold text-amber-600' :
                           'text-xs font-bold text-emerald-600';
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
      } else if (!this.state.isDemo && this.state.bpm == null) {
        quickTipEl.textContent = 'Ожидание измерений браслета для формирования индивидуальных рекомендаций.';
      } else {
        quickTipEl.textContent = 'Показатели стабильны. Поддерживайте водный баланс и регулярно проветривайте помещение.';
      }
    }

    // Дополнительные селекторы для вкладки Мониторинг и Мой риск
    const mBpm = document.getElementById('metric-bpm');
    if (mBpm) {
      mBpm.textContent = this.state.isDemo 
        ? (this.state.bpm || '72') 
        : (this.state.bpm != null ? this.state.bpm : '—');
    }
    const mSpo2 = document.getElementById('metric-spo2');
    if (mSpo2) {
      mSpo2.textContent = this.state.isDemo 
        ? `${this.state.spo2 || 98}%` 
        : (this.state.spo2 != null ? `${this.state.spo2}%` : '—');
    }
    const mSdnn = document.getElementById('metric-sdnn');
    if (mSdnn) {
      mSdnn.textContent = this.state.isDemo 
        ? Math.round(this.state.sdnn || 48) 
        : (this.state.sdnn != null ? Math.round(this.state.sdnn) : '—');
    }
    const mRiskVal = document.getElementById('risk-index-value');
    if (mRiskVal) {
      if (this.state.isDemo) {
        mRiskVal.textContent = (this.state.modelEvaluation && this.state.modelEvaluation.index != null) ? this.state.modelEvaluation.index : '18';
      } else {
        mRiskVal.textContent = (this.state.modelEvaluation && this.state.modelEvaluation.index != null) ? this.state.modelEvaluation.index : '—';
      }
    }

    this.renderRecentMeasurementsTable();

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
      <!-- 1. ИНТЕРАКТИВНЫЙ ДЫХАТЕЛЬНЫЙ ТРЕНАЖЕР 4-4-4 -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-700 font-bold text-base">
              🫁
            </div>
            <div>
              <h3 class="text-sm font-bold text-slate-900">Дыхательное упражнение 4–4–4</h3>
              <p class="text-[11px] text-slate-500">Нормализует ЧСС на 5–10 уд/мин и восстанавливает вегетативный баланс</p>
            </div>
          </div>
          <button id="btn-breathing-toggle" onclick="App.toggleBreathingExercise()" class="px-3.5 py-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold shadow-sm transition active:scale-95">
            ▶ Начать
          </button>
        </div>

        <!-- Animated Visualizer Box -->
        <div id="breathing-box" class="hidden flex flex-col items-center justify-center py-5 space-y-3 bg-slate-50 rounded-xl border border-slate-200">
          <div class="relative w-28 h-28 flex items-center justify-center">
            <div id="breathing-circle" class="w-20 h-20 rounded-full bg-teal-100 border-2 border-teal-500 flex items-center justify-center transition-all duration-1000">
              <span id="breathing-phase-sec" class="text-2xl font-bold font-mono text-teal-800">4</span>
            </div>
          </div>
          <div class="text-center space-y-0.5">
            <div id="breathing-phase-text" class="text-xs font-bold text-teal-800 uppercase tracking-wider">Вдох носом...</div>
            <div class="text-[11px] text-slate-500">Дышите животом, расслабьте плечи и шею</div>
          </div>
        </div>
      </div>

      <!-- 2. СРОЧНЫЙ ПЛАН УЛУЧШЕНИЯ -->
      <div class="bg-white rounded-2xl p-5 border ${isZoneRed ? 'border-rose-200 bg-rose-50/20' : isZoneYellow ? 'border-amber-200 bg-amber-50/20' : 'border-slate-200'} shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center space-x-2.5">
            <span class="w-6 h-6 rounded-lg ${isZoneRed ? 'bg-rose-100 text-rose-700' : isZoneYellow ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'} flex items-center justify-center text-xs font-bold">✓</span>
            <div>
              <h3 class="text-sm font-bold text-slate-900">Что сделать прямо сейчас</h3>
              <p class="text-[11px] text-slate-500">Персональные практические шаги для вашего здоровья</p>
            </div>
          </div>
          <span class="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
            ${plan.filter(p => p.isCompleted).length} из ${plan.length} выполнено
          </span>
        </div>

        <div class="space-y-2">
          ${plan.length === 0 ? `
            <div class="p-4 text-center text-xs text-slate-500">
              Показатели в норме. Особых корректирующих мер прямо сейчас не требуется. Продолжайте день в комфортном темпе!
            </div>
          ` : plan.map(item => `
            <div class="p-3.5 rounded-xl ${item.isCompleted ? 'bg-slate-50 border-emerald-200' : 'bg-white border-slate-200'} border flex items-start space-x-3 transition hover:shadow-xs">
              <button onclick="App.toggleActionCompleted('${item.id}')" class="mt-0.5 w-5 h-5 rounded-md border ${item.isCompleted ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex items-center justify-center transition flex-shrink-0">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
              <div class="space-y-0.5 flex-1">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold ${item.isCompleted ? 'line-through text-slate-400' : 'text-slate-900'}">
                    ${item.title}
                  </span>
                  <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ${item.priority === 'high' ? 'bg-rose-50 text-rose-700 border border-rose-200' : item.priority === 'medium' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-slate-100 text-slate-600'}">
                    ${item.category}
                  </span>
                </div>
                <div class="text-xs text-slate-600 leading-relaxed ${item.isCompleted ? 'line-through text-slate-400' : ''}">
                  ${item.action}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 3. ДЕТАЛЬНЫЙ РАЗБОР ФАКТОРОВ -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
        <div class="border-b border-slate-100 pb-2.5">
          <h3 class="text-sm font-bold text-slate-900">Разбор факторов кардио-оценки</h3>
          <p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
            Модель оценивает постоянные привычки (анкета) и динамику сердца (датчики) в реальном времени.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <!-- Группа 1: Анкета и привычки -->
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div class="flex items-center space-x-2 text-teal-800 font-bold border-b border-slate-200 pb-1.5">
              <span>📋 Анкета и анамнез (L_stat)</span>
            </div>
            ${stat ? `
            <div class="space-y-2 text-[11px] text-slate-600">
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Возраст:</span>
                <span class="font-semibold text-slate-800">${stat.normalized.A != null ? Math.round(stat.normalized.A * 10 + 40) : 40} лет</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">ИМТ:</span>
                <span class="font-semibold text-slate-800">${stat.normalized.bmi || 24.5} кг/м²</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Курение:</span>
                <span class="font-semibold ${stat.normalized.S ? 'text-amber-600' : 'text-emerald-700'}">${stat.normalized.S ? 'Да (+0.70)' : 'Нет (0)'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Активность:</span>
                <span class="font-semibold text-emerald-700">Поддерживает сердце</span>
              </div>
            </div>
            ` : `
            <div class="text-amber-600 text-xs">Анкета не заполнена полностью.</div>
            `}
          </div>

          <!-- Группа 2: Датчики браслета прямо сейчас -->
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div class="flex items-center space-x-2 text-teal-800 font-bold border-b border-slate-200 pb-1.5">
              <span>💓 Биомаркеры датчиков (L_dyn)</span>
            </div>
            <div class="space-y-2 text-[11px] text-slate-600">
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Пульс в покое:</span>
                <span class="font-semibold ${this.state.bpm > 95 ? 'text-amber-600' : 'text-emerald-700'}">${this.state.bpm || 72} уд/мин (норма: ${baseline.hr0 || 70})</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Кислород (SpO2):</span>
                <span class="font-semibold ${this.state.spo2 < 95 ? 'text-amber-600' : 'text-teal-700'}">${this.state.spo2 || 98}% (отлично)</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Ритм сердца:</span>
                <span class="font-semibold text-emerald-700">${this.state.pIrr > 0.1 ? 'Умеренная аритмия' : 'Ровный ритм'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-500">Качество данных (c):</span>
                <span class="font-semibold text-slate-800">${Math.round((q.percentage || 88))}%</span>
              </div>
            </div>
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-500 leading-relaxed">
          💡 <b>Напоминание:</b> Оценка носит ориентировочный характер для контроля повседневной нагрузки. При любых болях в груди, головокружении или нехватке воздуха обратитесь к врачу или вызовите 103.
        </div>
      </div>
    `;
  },

  updateConnectionUI() {
    const dot = document.getElementById('app-connection-indicator-dot');
    const label = document.getElementById('app-connection-indicator-text');
    const demoBar = document.getElementById('demo-mode-alert-bar');
    const realBar = document.getElementById('real-device-alert-bar');
    const sDot = document.getElementById('sidebar-device-dot');
    const sLabel = document.getElementById('sidebar-device-label');
    const sBadge = document.getElementById('sidebar-device-status-badge');
    const sensorStatusText = document.getElementById('home-sensor-status-subtitle');

    if (this.state.isDemo) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (label) label.textContent = 'Деморежим';
      if (demoBar) demoBar.classList.remove('hidden');
      if (realBar) realBar.classList.add('hidden');
      if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      if (sLabel) sLabel.textContent = 'Демо-режим активен';
      if (sBadge) {
        sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-medium';
        sBadge.textContent = 'Симуляция';
      }
      if (sensorStatusText) sensorStatusText.textContent = 'Генерация виртуальных биосигналов';
    } else if (this.state.isConnected) {
      if (demoBar) demoBar.classList.add('hidden');

      if (this.state.deviceState === 'connected_receiving') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        if (label) label.textContent = 'Подключено (BLE)';
        if (realBar) realBar.classList.add('hidden');
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        if (sLabel) sLabel.textContent = `${this.state.deviceName || 'Qamqor Band'} • Поток данных`;
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium';
          sBadge.textContent = 'Активен';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Датчики MAX30102 и AD8232 активны';
      } else {
        // connected_no_data
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-pulse';
        if (label) label.textContent = 'Подключено (нет данных)';
        if (realBar) realBar.classList.remove('hidden');
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-pulse';
        if (sLabel) sLabel.textContent = `${this.state.deviceName || 'Qamqor Band'} • Ожидание пальца`;
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-medium';
          sBadge.textContent = 'Ожидание';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Ожидание контакта с датчиком MAX30102';
      }
    } else {
      if (demoBar) demoBar.classList.add('hidden');
      if (realBar) realBar.classList.add('hidden');

      if (this.state.deviceState === 'reconnecting') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
        if (label) label.textContent = 'Переподключение...';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
        if (sLabel) sLabel.textContent = 'Восстановление связи с браслетом...';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-medium';
          sBadge.textContent = 'Повтор';
        }
        if (sensorStatusText) sensorStatusText.textContent = 'Попытка автоматического переподключения...';
      } else if (this.state.deviceState === 'connection_lost') {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
        if (label) label.textContent = 'Связь потеряна';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
        if (sLabel) sLabel.textContent = 'Связь с браслетом потеряна';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-medium';
          sBadge.textContent = 'Разрыв';
        }
      } else {
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-400';
        if (label) label.textContent = 'Не подключено';
        if (sDot) sDot.className = 'w-2 h-2 rounded-full bg-slate-400';
        if (sLabel) sLabel.textContent = 'Устройство не подключено';
        if (sBadge) {
          sBadge.className = 'inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-medium';
          sBadge.textContent = 'Офлайн';
        }
      }
      if (sensorStatusText) sensorStatusText.textContent = 'Браслет отключён';
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
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

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
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-stress-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshActivityButtons() {
    const val = this.state.surveyTemp.activity != null ? this.state.surveyTemp.activity : 1;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

    [0, 1, 2].forEach(lvl => {
      const btn = document.getElementById(`opt-activity-${lvl}`);
      if (btn) btn.className = val === lvl ? activeClass : inactiveClass;
    });
  },

  refreshFamilyButtons() {
    const val = this.state.surveyTemp.familyHistory;
    const activeClass = 'py-2.5 px-2 rounded-xl border-2 border-teal-700 bg-teal-700 text-white font-bold text-xs text-center shadow-xs transition';
    const inactiveClass = 'py-2.5 px-2 rounded-xl border border-slate-200 bg-white text-slate-700 font-semibold text-xs text-center hover:bg-slate-50 hover:text-slate-900 transition';

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
    const metricsRow = document.getElementById('survey-device-metrics-row');
    const metricsText = document.getElementById('survey-device-metrics-text');
    const goDashBtn = document.getElementById('survey-step4-go-dashboard-btn');

    const isConnected = this.state.isConnected;
    const isDemo = this.state.isDemo;
    const c = this.state.qualityResult ? this.state.qualityResult.c : 0;
    const hasData = this.state.bpm != null && this.state.spo2 != null;

    if (connText) {
      if (isDemo) {
        connText.innerHTML = '<span class="text-teal-800 font-bold">● Демо-режим активен</span>';
      } else if (isConnected && hasData) {
        connText.innerHTML = `<span class="text-emerald-800 font-bold">● Подключен • ЧСС: ${this.state.bpm} уд/мин, SpO2: ${this.state.spo2}%</span>`;
      } else if (isConnected) {
        connText.innerHTML = '<span class="text-emerald-800 font-bold">● Подключен по Bluetooth (ожидание данных)</span>';
      } else {
        connText.innerHTML = '<span class="text-slate-500">○ Не подключено</span>';
      }
    }

    if (qualityText) {
      if (isDemo || hasData || c >= 0.5) {
        qualityText.innerHTML = `<span class="text-emerald-800 font-bold">Стабилен (100% сигнал датчика)</span>`;
      } else if (isConnected) {
        qualityText.innerHTML = `<span class="text-amber-800 font-bold">Ожидание контакта</span>`;
      } else {
        qualityText.innerHTML = '<span class="text-slate-500">Ожидание измерений</span>';
      }
    }

    if (hintText) {
      if (isDemo) {
        hintText.innerHTML = '✅ <b>Демонстрация активна:</b> виртуальные датчики генерируют корректный физиологический сигнал для проверки.';
      } else if (isConnected && hasData) {
        hintText.innerHTML = `✅ <b>Реальные данные поступают:</b> пульс ${this.state.bpm} уд/мин, SpO2 ${this.state.spo2}%. Данные передаются на дашборд.`;
      } else if (isConnected) {
        hintText.innerHTML = 'ℹ️ <b>Браслет на связи:</b> приложите палец к датчику MAX30102 для считывания пульса и сатурации.';
      } else {
        hintText.innerHTML = '💡 Нажмите «Подключить по Bluetooth» или «Запустить в демо-режиме» для проверки биосигналов.';
      }
    }

    if (metricsRow && metricsText) {
      if (hasData) {
        metricsRow.classList.remove('hidden');
        metricsText.textContent = `ЧСС: ${this.state.bpm} уд/мин | SpO2: ${this.state.spo2}%`;
      } else {
        metricsRow.classList.add('hidden');
      }
    }

    if (goDashBtn) {
      if (isConnected || isDemo) {
        goDashBtn.classList.remove('hidden');
      } else {
        goDashBtn.classList.add('hidden');
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
        <div class="p-3 rounded-xl bg-slate-50 border ${c.ok ? 'border-slate-200' : 'border-amber-200 bg-amber-50/60'} space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-slate-500 text-[11px] font-medium">${c.label}</span>
            <span class="text-xs">${c.ok ? '✅' : '⚠️'}</span>
          </div>
          <div class="text-xs font-bold ${c.ok ? 'text-slate-900' : 'text-amber-800'}">${c.val}</div>
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
          const zoneBadge = modelEval.zone === 'green' ? '<span class="text-emerald-700 font-bold">Зеленая зона (Низкий риск)</span>'
            : modelEval.zone === 'yellow' ? '<span class="text-amber-700 font-bold">Желтая зона (Умеренный риск)</span>'
            : '<span class="text-rose-700 font-bold">Красная зона (Высокий риск)</span>';

          verdictContainer.className = 'p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-2';
          verdictContainer.innerHTML = `
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-950 uppercase tracking-wider">✅ Все данные собраны • Расчёт готов</span>
              <span class="text-xs font-mono font-bold text-emerald-900 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded">${modelEval.index} / 100</span>
            </div>
            <div class="text-xs text-slate-800 font-semibold">${zoneBadge}</div>
            <p class="text-xs text-slate-700 leading-relaxed font-normal">
              Математическая модель откалибрована. Базовый профиль L_stat = ${this.state.lStatResult.lStat.toFixed(2)}, динамическая составляющая учтена с качеством c = ${Math.round(c * 100)}%.
            </p>
          `;
        } else {
          verdictContainer.className = 'p-4 rounded-xl bg-teal-50 border border-teal-200 text-teal-950 space-y-2';
          verdictContainer.innerHTML = `
            <div class="text-xs font-bold text-teal-900 uppercase tracking-wider">ℹ️ Анкета сохранена • Ожидание стабильного сигнала</div>
            <p class="text-xs text-slate-700 leading-relaxed font-normal">
              Все 6 факторов анкеты успешно заполнены. Для вычисления динамического индекса необходим устойчивый сигнал датчика (порог c ≥ 0.5). Пока датчик калибруется, система отобразит статус «Недостаточно данных».
            </p>
          `;
        }
      } else {
        // Данных анкеты недостаточно
        const missingList = validation.missing.map(m => `• <b>${m.label}:</b> ${m.reason}`).join('<br>');
        verdictContainer.className = 'p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 space-y-2';
        verdictContainer.innerHTML = `
          <div class="text-xs font-bold text-amber-950 uppercase tracking-wider">⚠️ Расчёт индекса приостановлен (неполные данные)</div>
          <p class="text-xs text-slate-700 leading-relaxed font-normal">
            В соответствии со спецификацией Qamqor, математическая модель <b>не подменяет пропущенные ответы нулями или догадками</b>. Для точного расчёта не хватает следующих данных:<br>
            <div class="mt-2 text-xs text-amber-950 leading-relaxed bg-amber-100/80 border border-amber-200 p-2.5 rounded-xl">${missingList}</div>
          </p>
        `;
      }
    }

    // 3. Кнопки действий
    if (actionsContainer) {
      if (validation.isValid) {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition">
            Изменить ответы
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs shadow-sm transition text-center">
            Перейти в дашборд здоровья →
          </button>
        `;
      } else {
        actionsContainer.innerHTML = `
          <button type="button" onclick="App.goToSurveyStep(1)" class="py-2.5 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold transition">
            ← Дополнить анкету
          </button>
          <button type="button" onclick="App.completeSurveyAndOpenApp()" class="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold text-center transition">
            Открыть дашборд (только датчики) →
          </button>
        `;
      }
    }
  },

  completeSurveyAndOpenApp() {
    let profile = StorageService.getProfile();
    if (!profile) {
      const val = validateSurvey(this.state.surveyTemp);
      if (val.isValid) {
        profile = val.profile;
        StorageService.saveProfile(val.profile);
      } else {
        profile = Object.assign({}, StorageService.getDefaultDemoProfile(), this.state.surveyTemp);
        profile.name = profile.name || 'Пользователь Qamqor';
        StorageService.saveProfile(profile);
      }
    }
    if (profile) {
      try {
        this.state.lStatResult = calculateLStat(profile);
      } catch(e) {
        console.warn('L_stat calculation error:', e);
      }
      this.state.surveyValidation = validateSurvey(profile);
    }
    StorageService.setOnboarded(true);
    this.recalculateModel();
    this.showScreen('main-app');
    if (this.state.isDemo) {
      this.startDemoMode();
    } else {
      this.setRealDeviceMode();
    }
    this.renderAll();
    this.showToast('Добро пожаловать в дашборд Qamqor!', 'success');
  },

  submitSurvey() {
    this.nextSurveyStep(1);
  },

  renderRecentMeasurementsTable() {
    const tableBody = document.getElementById('recent-measurements-table-body');
    if (!tableBody) return;

    const hist = StorageService.getHistory();
    const latestItems = hist.slice(0, 5);

    if (latestItems.length === 0) {
      if (!this.state.isDemo && this.state.bpm == null) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="6" class="py-8 text-center text-xs text-slate-400">
              <div class="flex flex-col items-center justify-center space-y-1">
                <span>📡 Нет сохранённых измерений</span>
                <span class="text-[11px] text-slate-500">Подключите браслет по Bluetooth и приложите палец к датчику MAX30102</span>
              </div>
            </td>
          </tr>
        `;
        return;
      }
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const bpm = this.state.isDemo ? (this.state.bpm || 72) : (this.state.bpm || '—');
      const spo2 = this.state.isDemo ? (this.state.spo2 || 98) : (this.state.spo2 || '—');
      const sdnn = this.state.sdnn != null ? Math.round(this.state.sdnn) : (this.state.isDemo ? 48 : '—');
      const idx = this.state.modelEvaluation ? this.state.modelEvaluation.index : (this.state.isDemo ? 18 : '—');
      const zone = this.state.modelEvaluation ? this.state.modelEvaluation.zone : (this.state.isDemo ? 'green' : 'none');
      const badgeClass = zone === 'red' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                         zone === 'yellow' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                         zone === 'green' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                         'bg-slate-50 text-slate-600 border-slate-200';
      const statusText = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : zone === 'green' ? 'Норма' : 'Ожидание';

      tableBody.innerHTML = `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="py-2.5 px-3 font-mono text-slate-500">${timeStr}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${bpm} <span class="text-[10px] text-slate-400 font-sans">уд/м</span></td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${spo2 !== '—' ? spo2 + '%' : '—'}</td>
          <td class="py-2.5 px-3 font-mono text-slate-600">${sdnn} <span class="text-[10px] text-slate-400 font-sans">мс</span></td>
          <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${idx}</td>
          <td class="py-2.5 px-3 text-right">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeClass}">${statusText}</span>
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = latestItems.map(item => {
      const zone = item.zone || 'green';
      const badgeClass = zone === 'red' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                         zone === 'yellow' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                         'bg-emerald-50 text-emerald-700 border-emerald-200';
      const statusText = zone === 'red' ? 'Высокий риск' : zone === 'yellow' ? 'Внимание' : 'Норма';
      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="py-2.5 px-3 font-mono text-slate-500">${item.timeStr || '--:--'}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${item.bpm || '--'} <span class="text-[10px] text-slate-400 font-sans">уд/м</span></td>
          <td class="py-2.5 px-3 font-semibold text-slate-800 font-mono">${item.spo2 != null ? item.spo2 + '%' : '--'}</td>
          <td class="py-2.5 px-3 font-mono text-slate-600">${item.sdnn ? Math.round(item.sdnn) : '--'} <span class="text-[10px] text-slate-400 font-sans">мс</span></td>
          <td class="py-2.5 px-3 font-mono font-bold text-slate-900">${item.index != null ? item.index : '--'}</td>
          <td class="py-2.5 px-3 text-right">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeClass}">${statusText}</span>
          </td>
        </tr>
      `;
    }).join('');
  },

  renderRecommendationsTab() {
    const listEl = document.getElementById('recommendations-list');
    if (!listEl) return;

    const recs = this.state.recommendations || [];
    const plan = this.state.improvementPlan || [];

    if (recs.length === 0 && plan.length === 0) {
      listEl.innerHTML = `
        <div class="p-8 text-center text-slate-500 text-xs">
          Показатели в норме. Персональные рекомендации появятся при накоплении данных.
        </div>
      `;
      return;
    }

    listEl.innerHTML = recs.map(r => `
      <div class="p-4 rounded-xl bg-white border border-slate-200 shadow-sm space-y-2 hover:border-slate-300 transition">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-slate-900">${r.title}</span>
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
            ${r.category}
          </span>
        </div>
        <p class="text-xs text-slate-600 leading-relaxed">${r.description}</p>
        <div class="p-2.5 rounded-lg bg-teal-50 border border-teal-200 text-xs text-teal-800 font-medium flex items-center space-x-2">
          <span class="text-teal-600">💡</span>
          <span><b>Рекомендация:</b> ${r.action}</span>
        </div>
      </div>
    `).join('');
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
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between text-xs hover:border-slate-300 transition">
        <div class="flex items-center space-x-3">
          <span class="w-2.5 h-2.5 rounded-full ${h.isDemo ? 'bg-amber-400' : 'bg-emerald-500'} flex-shrink-0"></span>
          <div>
            <div class="font-semibold text-slate-900">${h.title}</div>
            <div class="text-[10px] text-slate-500 mt-0.5 font-mono">
              ${h.dateStr} ${h.timeStr} • Качество c: ${h.c != null ? Math.round(h.c * 100) + '%' : '--'}
            </div>
          </div>
        </div>
        <span class="font-mono font-bold text-slate-800 text-xs bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">${h.index != null ? 'Индекс: ' + h.index : ''}</span>
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
    const profile = StorageService.getProfile() || {};
    const nameEl = document.getElementById('settings-profile-name');
    const ageEl = document.getElementById('settings-profile-age');
    const bmiEl = document.getElementById('settings-profile-bmi');
    const verEl = document.getElementById('settings-model-version');

    if (nameEl) nameEl.textContent = profile.name || 'Пользователь';
    if (ageEl) ageEl.textContent = `${profile.age || 40} лет`;
    if (bmiEl) bmiEl.textContent = `${profile.bmi || 24.5} кг/м²`;
    if (verEl) verEl.textContent = MODEL_CONFIG.version;

    // Режим работы
    const badgeEl = document.getElementById('settings-current-mode-badge');
    const btnReal = document.getElementById('btn-mode-real');
    const btnDemo = document.getElementById('btn-mode-demo');

    const activeBtnClass = 'py-2.5 px-3 rounded-xl border-2 border-teal-700 bg-teal-700 text-white text-xs font-bold text-center shadow-xs transition';
    const inactiveBtnClass = 'py-2.5 px-3 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold text-center hover:bg-slate-50 hover:text-slate-900 transition';

    if (this.state.isDemo) {
      if (badgeEl) {
        badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200';
        badgeEl.textContent = 'Демо-режим';
      }
      if (btnDemo) btnDemo.className = activeBtnClass;
      if (btnReal) btnReal.className = inactiveBtnClass;
    } else {
      if (badgeEl) {
        badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
        badgeEl.textContent = 'Реальное устройство';
      }
      if (btnReal) btnReal.className = activeBtnClass;
      if (btnDemo) btnDemo.className = inactiveBtnClass;
    }
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
    const borderCol = type === 'success' ? 'border-emerald-200 bg-white text-emerald-800' :
                      type === 'warning' ? 'border-amber-200 bg-white text-amber-800' :
                      'border-teal-200 bg-white text-teal-800';

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
      arc.style.stroke = '#E2E8F0';
      if (centerNum) { centerNum.textContent = '--'; centerNum.style.fill = '#94A3B8'; }
      if (centerLabel) { centerLabel.textContent = 'Ожидание'; centerLabel.style.fill = '#94A3B8'; }
      return;
    }

    const pct = Math.min(100, Math.max(0, index)) / 100;
    const dashLen = pct * circumference;
    arc.style.strokeDasharray = dashLen + ' ' + (circumference - dashLen);
    arc.style.transition = 'stroke-dasharray 0.6s ease, stroke 0.4s ease';

    const color = zone === 'red' ? '#DC2626' : zone === 'yellow' ? '#F59E0B' : '#16A34A';
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

    const previewMessage = this.getFormattedGuardianAlertMessage('red');
    const previewDisplayHtml = previewMessage
      .replace(/\n/g, '<br>')
      .replace(/\*([^*]+)\*/g, '<b class="text-slate-900">$1</b>');

    tab.innerHTML = `
      <div class="space-y-4">
        <!-- Шапка -->
        <div class="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <span class="text-sm font-bold text-slate-900">Удалённый присмотр за близким</span>
              <span class="px-2 py-0.5 rounded-full bg-teal-50 text-teal-800 border border-teal-200 text-[10px] font-bold">Сын / Врач</span>
            </div>
            <p class="text-xs text-slate-500 leading-relaxed max-w-xl">
              Если браслет носит <b>мама</b>, а сын или врач находится <b>в другом городе</b> — система автоматически пришлёт срочный сигнал при росте риска или ухудшении пульса.
            </p>
          </div>
          <span class="text-3xl flex-shrink-0">👨‍⚕️</span>
        </div>

        <!-- КАРТОЧКА: ПРОВЕРКА ОТПРАВКИ И ПРЕДПРОСМОТР СООБЩЕНИЯ -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2.5">
              <span class="w-7 h-7 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center font-bold text-sm">📨</span>
              <div>
                <h3 class="text-sm font-bold text-slate-900">Проверка отправки в Telegram</h3>
                <p class="text-[11px] text-slate-500">Проверьте доставку уведомлений опекуну в реальном времени</p>
              </div>
            </div>
          </div>

          <!-- Предпросмотр текста сообщения для Telegram -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-slate-700 uppercase tracking-wider text-[11px]">💬 Формат сообщения для Telegram:</span>
              <span class="text-[10px] text-slate-400 font-mono">Markdown</span>
            </div>
            <div id="guardian-tg-preview" class="p-4 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-700 font-mono leading-relaxed">
              ${previewDisplayHtml}
            </div>
          </div>

          <!-- Кнопка проверки доставки -->
          <button id="btn-verify-telegram" onclick="App.verifyTelegramDelivery()" class="w-full py-2.5 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs shadow-sm active:scale-98 transition flex items-center justify-center space-x-2">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            <span>Проверить отправку в Telegram прямо сейчас</span>
          </button>

          <!-- Результат проверки в реальном времени -->
          <div id="guardian-verify-result-box" class="hidden p-3 rounded-xl border text-xs leading-relaxed space-y-1.5"></div>
        </div>

        <!-- 1. Быстрый обмен данными с сыном / врачом -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-bold text-slate-800 uppercase tracking-wider">Поделиться состоянием</div>
            <span class="text-[10px] font-mono text-teal-700 bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200">В 1 клик</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button onclick="App.shareViaWhatsApp()" class="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center justify-center space-x-2 transition shadow-sm">
              <span>💬 Отправить сводку в WhatsApp</span>
            </button>
            <button onclick="App.copyGuardianShareLink()" class="py-2.5 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200 flex items-center justify-center space-x-2 transition">
              <span>🔗 Скопировать ссылку для сына</span>
            </button>
          </div>
        </div>

        <!-- 2. Настройки опекуна (Telegram) -->
        <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-3.5">
          <div class="text-xs font-bold text-teal-800 uppercase tracking-wider">Настройки опекуна / врача</div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Имя опекуна <span class="text-slate-400 font-normal">(например: Сын Арман, Врач Карим)</span></label>
            <input type="text" id="guardian-name" value="${cfg.name || ''}" placeholder="Сын Арман" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Телефон опекуна <span class="text-slate-400 font-normal">(для экстренного звонка)</span></label>
            <input type="tel" id="guardian-phone" value="${cfg.phone || ''}" placeholder="+7 777 123 4567" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200 text-[11px] text-amber-800 leading-relaxed space-y-1">
            <div class="font-bold">⚡ Как настроить Telegram-бота:</div>
            <div>1. Откройте Telegram → найдите <b>@BotFather</b> → напишите <span class="font-mono">/newbot</span></div>
            <div>2. Вставьте сюда полученный <b>Bot Token</b></div>
            <div>3. Нажмите <span class="font-mono">/start</span> в вашем новом боте, а в <b>@userinfobot</b> узнайте свой <b>Chat ID</b></div>
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Telegram Bot Token <span class="text-rose-500">*</span></label>
            <input type="text" id="guardian-token" value="${cfg.botToken || ''}" placeholder="1234567890:AAHq_ABCDEF..." class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-700">Telegram Chat ID сына / опекуна <span class="text-rose-500">*</span></label>
            <input type="text" id="guardian-chatid" value="${cfg.chatId || ''}" placeholder="987654321" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-900 font-mono focus:outline-none focus:border-teal-600 focus:bg-white transition">
          </div>

          <div class="space-y-2 pt-1">
            <div class="text-xs font-medium text-slate-700">Когда присылать сигналы опекуну:</div>
            <label class="flex items-center space-x-3 cursor-pointer p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <input type="checkbox" id="guardian-notify-red" ${cfg.notifyRed ? 'checked' : ''} class="w-4 h-4 accent-rose-600 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-700">🔴 <b>Красная зона:</b> индекс ≥ 40 (Срочно!)</span>
            </label>
            <label class="flex items-center space-x-3 cursor-pointer p-2.5 rounded-xl bg-slate-50 border border-slate-200">
              <input type="checkbox" id="guardian-notify-det" ${cfg.notifyDeterioration ? 'checked' : ''} class="w-4 h-4 accent-amber-600 cursor-pointer flex-shrink-0">
              <span class="text-xs text-slate-700">🟡 <b>Ухудшение:</b> резкий скачок пульса или падение кислорода</span>
            </label>
          </div>

          <button onclick="App.saveGuardianSettings()" class="w-full py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs shadow-sm transition">
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
if (typeof window !== 'undefined') {
  window.App = App;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => App.init());
    } else {
      App.init();
    }
  }
}
