/**
 * Qamqor Health Monitoring System
 * Модуль локального хранилища (Storage Layer)
 * Реализация спецификации раздела 14, 15
 */

import { MODEL_CONFIG } from './config.js';

const STORAGE_KEYS = {
  ONBOARDED: 'qamqor_v3_onboarded',
  PROFILE: 'qamqor_v3_profile',
  BASELINE: 'qamqor_v3_baseline',
  ALERTS: 'qamqor_v3_alerts',
  MEASUREMENTS: 'qamqor_v3_measurements',
  HISTORY: 'qamqor_v3_history',
  IS_DEMO: 'qamqor_v3_is_demo',
  DEVICE_ALIAS: 'qamqor_v3_device_alias',
  SOS_ENDPOINT: 'qamqor_v3_sos_endpoint',
  COMPLETED_ACTIONS: 'qamqor_v3_completed_actions'
};

export const StorageService = {
  isOnboarded() {
    return localStorage.getItem(STORAGE_KEYS.ONBOARDED) === 'true';
  },

  setOnboarded(value) {
    localStorage.setItem(STORAGE_KEYS.ONBOARDED, value ? 'true' : 'false');
  },

  getProfile() {
    const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
    if (!raw) {
      return null;
    }
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
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
  },

  getBaseline() {
    const raw = localStorage.getItem(STORAGE_KEYS.BASELINE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveBaseline(data) {
    localStorage.setItem(STORAGE_KEYS.BASELINE, JSON.stringify(data));
  },

  getAlertsState() {
    const raw = localStorage.getItem(STORAGE_KEYS.ALERTS);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  saveAlertsState(data) {
    localStorage.setItem(STORAGE_KEYS.ALERTS, JSON.stringify(data));
  },

  isDemoMode() {
    return localStorage.getItem(STORAGE_KEYS.IS_DEMO) === 'true';
  },

  setDemoMode(val) {
    localStorage.setItem(STORAGE_KEYS.IS_DEMO, val ? 'true' : 'false');
  },

  getDeviceAlias() {
    return localStorage.getItem(STORAGE_KEYS.DEVICE_ALIAS) || 'Qamqor Band';
  },

  setDeviceAlias(name) {
    localStorage.setItem(STORAGE_KEYS.DEVICE_ALIAS, name);
  },

  getSOSEndpoint() {
    return localStorage.getItem(STORAGE_KEYS.SOS_ENDPOINT) || '';
  },

  setSOSEndpoint(url) {
    localStorage.setItem(STORAGE_KEYS.SOS_ENDPOINT, url);
  },

  getHistory() {
    const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  addHistoryEntry(entry) {
    const history = this.getHistory();
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      timestamp: Date.now(),
      dateStr: new Date().toLocaleDateString('ru-RU'),
      timeStr: new Date().toLocaleTimeString('ru-RU'),
      version: MODEL_CONFIG.version,
      ...entry
    };
    history.unshift(item);
    // Ограничиваем историю 300 записями
    if (history.length > 300) {
      history.pop();
    }
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    return item;
  },

  clearHistory() {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([]));
  },

  getCompletedActions() {
    const raw = localStorage.getItem(STORAGE_KEYS.COMPLETED_ACTIONS);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
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
    localStorage.setItem(STORAGE_KEYS.COMPLETED_ACTIONS, JSON.stringify(list));
    return list;
  },

  resetAll() {
    localStorage.clear();
  }
};
