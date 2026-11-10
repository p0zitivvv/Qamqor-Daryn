
const _memoryStore = {};

function safeGetItem(key) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
      return safeGetItem(key);
    }
  } catch (e) {}
  return _memoryStore[key] !== undefined ? _memoryStore[key] : null;
}

function safeSetItem(key, val) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
      safeSetItem(key, String(val));
      return;
    }
  } catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.number === -2147024882)) {
      throw e;
    }
  }
  _memoryStore[key] = String(val);
}

function safeRemoveItem(key) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.removeItem === 'function') {
      localStorage.removeItem(key);
      return;
    }
  } catch (e) {}
  delete _memoryStore[key];
}

/**
 * Qamqor Health Monitoring System
 * Модуль локального хранилища (Storage Layer)
 * 
 * Полная изоляция Demo Mode и Real Device Mode:
 * - HISTORY: реальные измерения с физического браслета
 * - DEMO_HISTORY: демонстрационные измерения
 * - AI_ADVISOR_CACHE_REAL / AI_ADVISOR_CACHE_DEMO: раздельные кэши рекомендаций
 */

import { MODEL_CONFIG } from './config.js';

const STORAGE_KEYS = {
  ONBOARDED: 'qamqor_v3_onboarded',
  PROFILE: 'qamqor_v3_profile',
  BASELINE: 'qamqor_v3_baseline',
  ALERTS: 'qamqor_v3_alerts',
  MEASUREMENTS: 'qamqor_v3_measurements',
  HISTORY: 'qamqor_v3_history',
  DEMO_HISTORY: 'qamqor_v3_demo_history',
  IS_DEMO: 'qamqor_v3_is_demo',
  DEVICE_ALIAS: 'qamqor_v3_device_alias',
  SOS_ENDPOINT: 'qamqor_v3_sos_endpoint',
  THEME: 'qamqor_v3_theme',
  COMPLETED_ACTIONS: 'qamqor_v3_completed_actions',
  AI_ADVISOR_CACHE_REAL: 'qamqor_v3_ai_cache_real',
  AI_ADVISOR_CACHE_DEMO: 'qamqor_v3_ai_cache_demo',
  // Устаревший ключ для обратной совместимости
  AI_ADVISOR_CACHE: 'qamqor_v3_ai_advisor_cache'
};

/**
 * Нормализация записи истории для обратной совместимости
 */
export function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const dateObj = new Date(timestamp);

  const dateStr = raw.dateStr || raw.date || dateObj.toLocaleDateString('ru-RU');
  const timeStr = raw.timeStr || raw.time || dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const bpm = typeof raw.bpm === 'number' ? raw.bpm : (typeof raw.hr === 'number' ? raw.hr : null);
  const spo2 = typeof raw.spo2 === 'number' ? raw.spo2 : null;
  const sdnn = typeof raw.sdnn === 'number' ? raw.sdnn : (typeof raw.hrv === 'number' ? raw.hrv : null);
  const rmssd = typeof raw.rmssd === 'number' ? raw.rmssd : null;

  const isDemo = Boolean(raw.isDemo || raw.source === 'demo' || (raw.source && String(raw.source).toLowerCase().includes('демо')));
  const source = isDemo ? 'demo' : (raw.source || 'real');

  return {
    id: raw.id || (timestamp.toString(36) + Math.random().toString(36).slice(2, 6)),
    timestamp,
    dateStr,
    timeStr,
    date: dateStr, // псевдоним
    time: timeStr, // псевдоним
    source,
    isDemo,
    bpm,
    spo2,
    sdnn,
    rmssd,
    index: raw.index != null ? raw.index : '—',
    zone: raw.zone || 'green',
    c: typeof raw.c === 'number' ? raw.c : null,
    title: raw.title || (isDemo ? 'Демонстрационный срез' : 'Замер Qamqor Band'),
    version: raw.version || MODEL_CONFIG.version
  };
}

export const StorageService = {
  isOnboarded() {
    
    return safeGetItem(STORAGE_KEYS.ONBOARDED) === 'true';
  },

  setOnboarded(value) {
    
    safeSetItem(STORAGE_KEYS.ONBOARDED, value ? 'true' : 'false');
  },

  getProfile() {
    
    const raw = safeGetItem(STORAGE_KEYS.PROFILE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  getDefaultDemoProfile() {
    return {
      name: 'Демо-Пользователь',
      age: 40,
      gender: 'unspecified',
      heightCm: 175,
      weightKg: 75,
      bmi: 24.5,
      smoking: 0,
      familyHistory: 0,
      stress: 1, // 0-низкий, 1-умеренный, 2-высокий
      activity: 1 // 0-низкая, 1-средняя, 2-высокая
    };
  },

  saveProfile(profile) {
    
    safeSetItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
  },

  getBaseline() {
    
    const raw = safeGetItem(STORAGE_KEYS.BASELINE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveBaseline(data) {
    
    safeSetItem(STORAGE_KEYS.BASELINE, JSON.stringify(data));
  },

  getAlertsState() {
    
    const raw = safeGetItem(STORAGE_KEYS.ALERTS);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveAlertsState(data) {
    
    safeSetItem(STORAGE_KEYS.ALERTS, JSON.stringify(data));
  },

  isDemoMode() {
    
    return safeGetItem(STORAGE_KEYS.IS_DEMO) === 'true';
  },

  setDemoMode(val) {
    
    safeSetItem(STORAGE_KEYS.IS_DEMO, val ? 'true' : 'false');
  },

  getDeviceAlias() {
    
    return safeGetItem(STORAGE_KEYS.DEVICE_ALIAS) || 'Qamqor Band';
  },

  setDeviceAlias(name) {
    
    safeSetItem(STORAGE_KEYS.DEVICE_ALIAS, name);
  },

  getSOSEndpoint() {
    
    return safeGetItem(STORAGE_KEYS.SOS_ENDPOINT) || '';
  },

  setSOSEndpoint(url) {
    
    safeSetItem(STORAGE_KEYS.SOS_ENDPOINT, url);
  },

  getTheme() {
    return safeGetItem(STORAGE_KEYS.THEME) || 'light';
  },

  setTheme(theme) {
    if (!['light', 'white', 'dark'].includes(theme)) theme = 'light';
    safeSetItem(STORAGE_KEYS.THEME, theme);
    return theme;
  },

  // ========================================================
  // РАЗДЕЛЬНОЕ ХРАНЕНИЕ ИСТОРИИ (REAL vs DEMO)
  // ========================================================

  getHistory(isDemo = false) {
    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;
    const raw = safeGetItem(key);

    if (!raw) {
      if (isDemo) {
        const defaultDemo = this.generateDefaultDemoHistory();
        this.saveHistory(defaultDemo, true);
        return defaultDemo;
      }
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeHistoryEntry).filter(Boolean);
    } catch {
      return [];
    }
  },

  saveHistory(history, isDemo = false) {
    
    if (!Array.isArray(history)) return false;

    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;

    try {
      // Нормализуем и ограничиваем историю 500 записями
      const normalized = history.slice(0, 500).map(normalizeHistoryEntry).filter(Boolean);
      safeSetItem(key, JSON.stringify(normalized));
      return true;
    } catch (e) {
      console.warn('[StorageService] Ошибка записи истории в localStorage:', e);
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.number === -2147024882)) {
        try {
          const reduced = history.slice(0, 100).map(normalizeHistoryEntry).filter(Boolean);
          safeSetItem(key, JSON.stringify(reduced));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  },

  addHistoryEntry(entry, isDemo = false) {
    const history = this.getHistory(isDemo);
    const normalized = normalizeHistoryEntry({
      ...entry,
      isDemo,
      source: isDemo ? 'demo' : 'real'
    });

    if (!normalized) return null;

    history.unshift(normalized);
    if (history.length > 500) history.pop();

    this.saveHistory(history, isDemo);
    return normalized;
  },

  clearHistory(isDemo = false) {
    
    const key = isDemo ? STORAGE_KEYS.DEMO_HISTORY : STORAGE_KEYS.HISTORY;
    safeSetItem(key, JSON.stringify([]));
  },

  /**
   * Генерация реалистичной 7-дневной истории для Demo Mode
   */
  generateDefaultDemoHistory() {
    const list = [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Срезы за последние 7 дней (по 2-3 замера в день)
    const templates = [
      { dayOffset: 0, time: '18:30', bpm: 74, spo2: 98, sdnn: 48, rmssd: 42, index: 18, zone: 'green' },
      { dayOffset: 0, time: '12:15', bpm: 78, spo2: 98, sdnn: 45, rmssd: 39, index: 21, zone: 'yellow' },
      { dayOffset: 0, time: '08:45', bpm: 71, spo2: 99, sdnn: 52, rmssd: 46, index: 16, zone: 'green' },
      { dayOffset: 1, time: '20:10', bpm: 73, spo2: 98, sdnn: 50, rmssd: 44, index: 17, zone: 'green' },
      { dayOffset: 1, time: '14:20', bpm: 82, spo2: 97, sdnn: 41, rmssd: 36, index: 24, zone: 'yellow' },
      { dayOffset: 2, time: '19:00', bpm: 75, spo2: 98, sdnn: 47, rmssd: 41, index: 19, zone: 'green' },
      { dayOffset: 2, time: '11:30', bpm: 80, spo2: 98, sdnn: 43, rmssd: 38, index: 22, zone: 'yellow' },
      { dayOffset: 3, time: '17:45', bpm: 76, spo2: 97, sdnn: 46, rmssd: 40, index: 20, zone: 'yellow' },
      { dayOffset: 4, time: '19:20', bpm: 72, spo2: 99, sdnn: 51, rmssd: 45, index: 16, zone: 'green' },
      { dayOffset: 5, time: '18:10', bpm: 77, spo2: 98, sdnn: 44, rmssd: 39, index: 21, zone: 'yellow' },
      { dayOffset: 6, time: '16:40', bpm: 70, spo2: 99, sdnn: 54, rmssd: 48, index: 15, zone: 'green' }
    ];

    templates.forEach((t, idx) => {
      const ts = now - t.dayOffset * dayMs;
      const d = new Date(ts);
      list.push(normalizeHistoryEntry({
        id: 'demo_hist_' + (idx + 1),
        timestamp: ts,
        dateStr: d.toLocaleDateString('ru-RU'),
        timeStr: t.time,
        source: 'demo',
        isDemo: true,
        bpm: t.bpm,
        spo2: t.spo2,
        sdnn: t.sdnn,
        rmssd: t.rmssd,
        index: t.index,
        zone: t.zone,
        c: 0.95,
        title: 'Демо-срез: контрольный замер'
      }));
    });

    return list;
  },

  // ========================================================
  // AI ADVISOR КЭШ (РАЗДЕЛЬНЫЙ REAL / DEMO)
  // ========================================================

  getAIAdvisorCache(isDemo = false) {
    
    const key = isDemo ? STORAGE_KEYS.AI_ADVISOR_CACHE_DEMO : STORAGE_KEYS.AI_ADVISOR_CACHE_REAL;
    const raw = safeGetItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveAIAdvisorCache(data, isDemo = false) {
    
    if (!data) return;
    const key = isDemo ? STORAGE_KEYS.AI_ADVISOR_CACHE_DEMO : STORAGE_KEYS.AI_ADVISOR_CACHE_REAL;
    try {
      safeSetItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('[StorageService] Error saving AI advisor cache:', e);
    }
  },

  getCompletedActions() {
    
    const raw = safeGetItem(STORAGE_KEYS.COMPLETED_ACTIONS);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  saveCompletedActions(actions) {
    
    if (!Array.isArray(actions)) return;
    try {
      safeSetItem(STORAGE_KEYS.COMPLETED_ACTIONS, JSON.stringify(actions));
    } catch (e) {
      console.warn('[StorageService] Error saving completed actions:', e);
    }
  },

  toggleActionCompleted(actionId) {
    
    const list = this.getCompletedActions();
    const idx = list.indexOf(actionId);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.push(actionId);
    }
    safeSetItem(STORAGE_KEYS.COMPLETED_ACTIONS, JSON.stringify(list));
    return list;
  },

  resetAll() {
    
    localStorage.clear();
  }
};

StorageService.normalizeHistoryEntry = normalizeHistoryEntry;
