/**
 * Qamqor Health Monitoring System
 * Модуль демонстрационного режима (Demo Simulator)
 * Реализация спецификации раздела 12.2
 */

export class DemoSimulator {
  constructor() {
    this.intervalId = null;
    this.isPaused = false;
    this.bpm = 72;
    this.spo2 = 98;
    this.sdnn = 48; // мс
    this.pIrr = 0.02; // Низкая нерегулярность
    this.scenario = 'normal'; // 'normal' | 'tachycardia' | 'hypoxia' | 'irregular'
    
    this.onSample = null;
    this.sampleCount = 0;
  }

  start(callback) {
    this.onSample = callback;
    this.isPaused = false;
    this.stop();

    // Отправляем первый сэмпл немедленно
    this.emitSample();

    // Периодическое обновление каждые 1.5 секунды
    this.intervalId = setInterval(() => {
      if (!this.isPaused) {
        this.stepSimulation();
        this.emitSample();
      }
    }, 1500);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  setScenario(scenario) {
    this.scenario = scenario;
    if (scenario === 'tachycardia') {
      this.bpm = 108;
      this.sdnn = 24;
      this.spo2 = 96;
    } else if (scenario === 'hypoxia') {
      this.bpm = 88;
      this.spo2 = 91;
      this.sdnn = 32;
    } else if (scenario === 'irregular') {
      this.bpm = 78;
      this.pIrr = 0.35;
      this.sdnn = 65;
    } else {
      this.bpm = 72;
      this.spo2 = 98;
      this.sdnn = 48;
      this.pIrr = 0.02;
    }
  }

  stepSimulation() {
    this.sampleCount++;

    if (this.scenario === 'normal') {
      // Естественное физиологическое блуждание синусового ритма
      const bpmWander = (Math.random() - 0.49) * 1.8;
      this.bpm = Math.round(Math.min(84, Math.max(64, this.bpm + bpmWander)));

      if (Math.random() > 0.8) {
        this.spo2 = Math.min(99, Math.max(96, this.spo2 + (Math.random() > 0.5 ? 1 : -1)));
      }
      this.sdnn = Math.round(Math.min(60, Math.max(38, this.sdnn + (Math.random() - 0.5) * 3)));
      this.pIrr = Math.max(0, Math.min(0.08, this.pIrr + (Math.random() - 0.5) * 0.01));
    } else if (this.scenario === 'tachycardia') {
      const bpmWander = (Math.random() - 0.48) * 2;
      this.bpm = Math.round(Math.min(125, Math.max(98, this.bpm + bpmWander)));
      this.sdnn = Math.round(Math.min(28, Math.max(16, this.sdnn + (Math.random() - 0.5) * 2)));
    } else if (this.scenario === 'hypoxia') {
      this.spo2 = Math.min(93, Math.max(88, this.spo2 + (Math.random() > 0.5 ? 1 : -1)));
      this.bpm = Math.round(Math.min(96, Math.max(82, this.bpm + (Math.random() - 0.5) * 2)));
    }
  }

  emitSample() {
    if (!this.onSample) return;

    this.onSample({
      bpm: this.bpm,
      spo2: this.spo2,
      sdnn: this.sdnn,
      pIrr: this.pIrr,
      isDemo: true,
      timestamp: Date.now()
    });
  }
}
