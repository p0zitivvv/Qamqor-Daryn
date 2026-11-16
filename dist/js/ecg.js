/**
 * Qamqor Health Monitoring System
 * Модуль осциллографа ЭКГ на HTML5 Canvas (ECG Oscilloscope)
 * Реализация спецификации раздела 7.2 и 11
 *
 * Прошивка шлёт 250 Гц пакетами по 10 отсчётов каждые 40 мс.
 * Рисуем КАЖДЫЙ отсчёт (без пропусков и интерполяции), развёртка идёт по времени,
 * а размер очереди держится около целевой задержки.
 */

// --- Параметры сигнала и развёртки ---
const SAMPLE_RATE_HZ = 250;          // частота дискретизации прошивки
const PX_PER_SECOND = 125;           // скорость развёртки (~0.5 px на отсчёт)
const SWEEP_GAP_PX = 24;             // ширина «стирающего» зазора перед лучом

// --- Допустимый диапазон 12-битного ADC (0 и 4095 — признак обрыва/насыщения) ---
const ADC_MIN_VALID = 50;
const ADC_MAX_VALID = 4040;
const INVALID_RUN_RESET = 3;         // столько подряд плохих отсчётов — сброс изолинии фильтра

// --- Очередь и задержка ---
const TARGET_LATENCY_SAMPLES = 40;   // ~160 мс запаса против BLE-джиттера
const MAX_QUEUE_SAMPLES = 250;       // ~1 с; больше — подрезаем до целевой задержки

// --- Контроль реальной частоты ---
const RATE_TOLERANCE = 0.15;         // ±15% от 250 Гц считается нормой
const STALE_MS = 2000;               // нет отсчётов дольше — «Ожидание ЭКГ»
const VALID_FRESH_MS = 1000;         // нет ВАЛИДНЫХ отсчётов дольше — «Нет сигнала»

// --- Цифровые фильтры (коэффициенты считаются из частот среза) ---
const HP_CUTOFF_HZ = 0.5;            // удаление дрейфа изолинии
const LP_CUTOFF_HZ = 25;             // сглаживание высокочастотного шума
const HP_ALPHA = 1 - Math.exp(-2 * Math.PI * HP_CUTOFF_HZ / SAMPLE_RATE_HZ);
const LP_ALPHA = 1 - Math.exp(-2 * Math.PI * LP_CUTOFF_HZ / SAMPLE_RATE_HZ);

// --- Стабилизация после старта / обрыва электродов ---
const SETTLE_SAMPLES = 100;          // ~0.4 с: фильтр сходится, линия не рисуется
const SETTLE_HP_ALPHA = 0.08;        // быстрая подстройка изолинии в это время
const PEAK_SPAN_MAX = 1500;          // верхний предел AGC (в отсчётах ADC)

// --- Стили статус-плашки ---
const PILL_BASE = 'text-[10px] px-2 py-0.5 rounded-full border';
const PILL_SLATE = `${PILL_BASE} bg-slate-100 text-slate-500 border-slate-200 font-medium`;
const PILL_SKY = `${PILL_BASE} bg-sky-50 text-sky-700 border-sky-200 font-mono font-medium`;
const PILL_GREEN = `${PILL_BASE} bg-emerald-50 text-emerald-700 border-emerald-200 font-mono font-semibold`;
const PILL_AMBER = `${PILL_BASE} bg-amber-50 text-amber-700 border-amber-200 font-mono font-semibold`;
const PILL_RED = `${PILL_BASE} bg-rose-50 text-rose-700 border-rose-200 font-mono font-semibold`;

const BG_COLOR = '#060b13';

export class ECGCanvasService {
  constructor() {
    this.canvases = [];
    this.animId = null;
    this.hasStream = false;
    this.isPaused = false;
    this.currentBpm = 72;
    this.allowSynthetic = false;

    // Очередь нормализованных отсчётов (NaN = невалидный отсчёт, рисуется как разрыв линии)
    this.realECGQueue = [];
    this.buffering = true;        // накопление стартового запаса перед показом
    this.drainAccum = 0;          // дробный аккумулятор числа отсчётов на кадр
    this.lastFrameMs = 0;
    this.synthT = 0;              // время демо-сигнала

    this.lastRealSampleTime = 0;  // последний ПОЛУЧЕННЫЙ отсчёт (любой)
    this.lastValidSampleTime = 0; // последний ВАЛИДНЫЙ отсчёт
    this.invalidRun = 0;

    // Измерение реальной частоты поступления отсчётов
    this.rateWindowStart = 0;
    this.rateWindowCount = 0;
    this.measuredRateHz = null;

    // Статистика
    this.droppedSamples = 0;
    this.invalidSamples = 0;

    // Цифровая фильтрация и масштабирование реального AD8232
    this.baselineEMA = 2048.0;
    this.baselineInitialized = false;
    this.lpFiltered = 0.0;
    this.peakSpanEMA = 350.0;     // динамический диапазон для AGC

    this.invert = false;          // инверсия полярности (если электроды перепутаны)
    this.leadsOff = false;        // обрыв электродов (сообщает ble.js через setLeadsOff)
    this.settleLeft = 0;          // сколько отсчётов ещё идёт подстройка после старта/обрыва
    this.debug = false;           // раз в секунду печатать диагностику в консоль
    this.rawStats = null;         // статистика сырого ADC за последнюю секунду
    this._resetWindowStats();

    this._onResize = () => this.refresh();
    this._resizeBound = false;
  }

  init(canvasConfigs) {
    this.canvases = [];
    canvasConfigs.forEach(cfg => {
      const el = document.getElementById(cfg.canvasId);
      if (el) {
        this.canvases.push({
          id: cfg.canvasId,
          canvas: el,
          ctx: el.getContext('2d'),
          emptyState: document.getElementById(cfg.emptyStateId),
          statusPill: document.getElementById(cfg.statusPillId),
          buffer: new Float32Array(0), // нормализованные значения, индекс = номер отсчёта на экране
          head: 0,                     // позиция записи (= положение луча)
          _statusKey: null
        });
      }
    });

    if (!this._resizeBound) {
      window.addEventListener('resize', this._onResize);
      this._resizeBound = true;
    }
    if (!this.animId) {
      this.loop();
    }
  }

  destroy() {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this._resizeBound) {
      window.removeEventListener('resize', this._onResize);
      this._resizeBound = false;
    }
  }

  // ------------------------------------------------------------------
  // Управление потоком
  // ------------------------------------------------------------------

  setStreamActive(active, allowSynthetic = false) {
    const modeChanged = this.allowSynthetic !== allowSynthetic;
    this.hasStream = active;
    this.allowSynthetic = allowSynthetic;

    // Сброс только при остановке или смене режима (демо <-> реальный),
    // повторные вызовы с тем же состоянием ничего не ломают.
    if (!active || modeChanged) {
      this._resetRealState();
      this._clearTraces();
    }

    if (this.canvases.length === 0) {
      this.init([
        { canvasId: 'homeECGCanvas', emptyStateId: 'home-ecg-empty-state', statusPillId: 'home-ecg-status-pill' },
        { canvasId: 'liveECGCanvas', emptyStateId: 'ecg-empty-state', statusPillId: 'ecg-status-pill' }
      ]);
    }
    if (!this.animId) {
      this.loop();
    }

    const nowMs = performance.now();
    this.canvases.forEach(item => this._applyStatus(item, nowMs));
  }

  setBPM(bpm) {
    if (typeof bpm === 'number' && bpm > 30) {
      this.currentBpm = bpm;
    }
  }

  /**
   * Инверсия полярности. Нужна, если R-зубец смотрит вниз
   * (электроды RA/LA перепутаны местами).
   */
  setInvert(flag) {
    const f = !!flag;
    if (f === this.invert) return;
    this.invert = f;
    this.realECGQueue = [];
    this.buffering = true;
    this.drainAccum = 0;
    this._clearTraces();
  }

  /**
   * Сообщить об обрыве/восстановлении электродов (telemetry.ecgSensorStatus === 'leads_off').
   * При обрыве экран очищается, при возвращении контакта фильтр стартует заново
   * с короткой подстройкой — без скачков.
   */
  setLeadsOff(flag) {
    const f = !!flag;
    if (f === this.leadsOff) return;
    this.leadsOff = f;
    this.baselineInitialized = false;
    this.invalidRun = 0;
    this.realECGQueue = [];
    this.buffering = true;
    this.drainAccum = 0;
    if (f) {
      this.lastValidSampleTime = 0;
      this._clearTraces();
    }
  }

  /** Раз в секунду печатать в консоль частоту, диапазон ADC, изолинию, масштаб и подсказку по полярности. */
  setDebug(flag) {
    this.debug = !!flag;
  }

  _resetRealState() {
    this.realECGQueue = [];
    this.buffering = true;
    this.drainAccum = 0;
    this.baselineInitialized = false;
    this.lpFiltered = 0.0;
    this.invalidRun = 0;
    this.lastRealSampleTime = 0;
    this.lastValidSampleTime = 0;
    this.rateWindowStart = 0;
    this.rateWindowCount = 0;
    this.measuredRateHz = null;
    this.settleLeft = 0;
    this.leadsOff = false;
    this._resetWindowStats();
  }

  _clearTraces() {
    this.canvases.forEach(item => {
      item.buffer.fill(NaN);
      item.head = 0;
    });
  }

  // ------------------------------------------------------------------
  // Приём реальных данных
  // ------------------------------------------------------------------

  /**
   * Принять пакет отсчётов (например, telemetry.ecgSamples — 10 штук за 40 мс).
   */
  pushRealSamples(samples) {
    if (!Array.isArray(samples)) return;
    for (let i = 0; i < samples.length; i++) {
      this.pushRealSample(samples[i]);
    }
  }

  /**
   * Принять один сырой отсчёт ADC (0..4095).
   * Значения вне диапазона (в т.ч. 0 и 4095) НЕ считаются ЭКГ: в очередь уходит NaN,
   * линия разрывается, а статус показывает «Нет сигнала».
   */
  pushRealSample(adcValue) {
    if (this.allowSynthetic) return; // в демо-режиме реальные данные игнорируем
    if (this.leadsOff) return;       // при обрыве электродов отсчёты — мусор, не рисуем

    const now = performance.now();

    // После паузы в данных перезапускаем измерение частоты
    if (this.lastRealSampleTime > 0 && now - this.lastRealSampleTime > STALE_MS) {
      this.rateWindowStart = 0;
      this.rateWindowCount = 0;
      this.measuredRateHz = null;
      this.baselineInitialized = false;
      this.buffering = true;
      this._resetWindowStats();
    }
    if (this.rateWindowStart === 0) {
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
    this.rateWindowCount++;
    this.lastRealSampleTime = now;

    const valid =
      typeof adcValue === 'number' &&
      Number.isFinite(adcValue) &&
      adcValue >= ADC_MIN_VALID &&
      adcValue <= ADC_MAX_VALID;

    if (!valid) {
      this.invalidSamples++;
      this.invalidRun++;
      if (this.invalidRun >= INVALID_RUN_RESET) {
        this.baselineInitialized = false; // после восстановления сигнала изолиния пересчитается
      }
      this._enqueue(NaN);
      return;
    }

    this.invalidRun = 0;
    this.lastValidSampleTime = now;

    if (!this.baselineInitialized) {
      this.baselineEMA = adcValue;
      this.lpFiltered = 0.0;
      this.baselineInitialized = true;
      this.settleLeft = SETTLE_SAMPLES; // короткая подстройка: фильтр сходится, линия не рисуется
    }

    // 1. Удаление постоянной составляющей и дрейфа изолинии (high-pass ~0.5 Гц).
    // Изолиния — бегущее среднее самого сигнала, а не константа 2048: выход AD8232
    // сидит около 1.5 В (≈1800–2000 отсчётов) и плавает от электродов и кожи.
    const settling = this.settleLeft > 0;
    this.baselineEMA += (adcValue - this.baselineEMA) * (settling ? SETTLE_HP_ALPHA : HP_ALPHA);
    const acSignal = adcValue - this.baselineEMA;

    this._trackWindowStats(adcValue, acSignal);

    // 2. Низкочастотный IIR-фильтр (~25 Гц): сглаживает ВЧ-шум.
    // Однополюсный фильтр сетевую наводку 50 Гц заметно не подавляет.
    this.lpFiltered += (acSignal - this.lpFiltered) * LP_ALPHA;

    // Во время подстройки линию не рисуем (NaN) и AGC не трогаем:
    // переходный процесс не должен раздувать масштаб и «топить» сигнал вниз.
    if (settling) {
      this.settleLeft--;
      this._enqueue(NaN);
      return;
    }

    // 3. Автоматическая подстройка масштаба (AGC) с верхним пределом
    const absVal = Math.abs(this.lpFiltered);
    if (absVal > this.peakSpanEMA) {
      this.peakSpanEMA = Math.min(PEAK_SPAN_MAX, this.peakSpanEMA * 0.95 + absVal * 0.05);
    } else {
      this.peakSpanEMA = Math.max(120.0, this.peakSpanEMA * 0.9995);
    }

    // 4. Нормализация в диапазон около [-1.0, 1.0]
    const scaleFactor = Math.max(160.0, this.peakSpanEMA * 1.35);
    let norm = this.lpFiltered / scaleFactor;
    if (this.invert) norm = -norm; // полярность перевёрнута (электроды перепутаны)

    // Мягкое скругление вместо жёсткого клиппинга
    if (norm > 1.25) norm = 1.25 + Math.tanh(norm - 1.25) * 0.25;
    if (norm < -1.25) norm = -1.25 + Math.tanh(norm + 1.25) * 0.25;

    this._enqueue(norm);
  }

  _enqueue(value) {
    this.realECGQueue.push(value);
    // Защита от переполнения: если отрисовка отстала (фоновая вкладка, пауза),
    // выбрасываем самое старое и оставляем целевой запас.
    if (this.realECGQueue.length > MAX_QUEUE_SAMPLES) {
      const drop = this.realECGQueue.length - TARGET_LATENCY_SAMPLES;
      this.realECGQueue.splice(0, drop);
      this.droppedSamples += drop;
    }
  }

  getStats() {
    return {
      measuredRateHz: this.measuredRateHz,
      queueLength: this.realECGQueue.length,
      droppedSamples: this.droppedSamples,
      invalidSamples: this.invalidSamples,
      invert: this.invert,
      leadsOff: this.leadsOff,
      baseline: Math.round(this.baselineEMA),
      gainSpan: Math.round(this.peakSpanEMA),
      raw: this.rawStats // {min, max, mean, devMax, devMin, polarity} за последнюю секунду
    };
  }

  _resetWindowStats() {
    this.winMin = Infinity;
    this.winMax = -Infinity;
    this.winSum = 0;
    this.winN = 0;
    this.winDevMax = -Infinity;
    this.winDevMin = Infinity;
  }

  _trackWindowStats(adc, ac) {
    if (adc < this.winMin) this.winMin = adc;
    if (adc > this.winMax) this.winMax = adc;
    this.winSum += adc;
    this.winN++;
    if (ac > this.winDevMax) this.winDevMax = ac;
    if (ac < this.winDevMin) this.winDevMin = ac;
  }

  _updateRate(nowMs) {
    if (this.rateWindowStart > 0) {
      const elapsed = nowMs - this.rateWindowStart;
      if (elapsed >= 1000) {
        this.measuredRateHz = (this.rateWindowCount * 1000) / elapsed;
        this.rateWindowStart = nowMs;
        this.rateWindowCount = 0;

        if (this.winN > 0) {
          // Подсказка по полярности: R-зубец — самый большой отклонение сигнала.
          // Если сильнее всего сигнал уходит ВНИЗ от изолинии, вероятно, он перевёрнут.
          const up = Math.abs(this.winDevMax);
          const down = Math.abs(this.winDevMin);
          let polarity = 'неопределённая';
          if (Math.max(up, down) > 80) {
            polarity = down > up * 1.5 ? 'вероятно ПЕРЕВЁРНУТА' : 'нормальная';
          }
          this.rawStats = {
            min: this.winMin,
            max: this.winMax,
            mean: Math.round(this.winSum / this.winN),
            devMax: Math.round(this.winDevMax),
            devMin: Math.round(this.winDevMin),
            polarity
          };
          if (this.debug) {
            console.log(
              `[ECG] ${Math.round(this.measuredRateHz)} Гц | ADC min/max/mean = ` +
              `${this.rawStats.min}/${this.rawStats.max}/${this.rawStats.mean} | ` +
              `отклонение +${this.rawStats.devMax}/${this.rawStats.devMin} | ` +
              `изолиния=${Math.round(this.baselineEMA)} масштаб=${Math.round(this.peakSpanEMA)} | ` +
              `полярность: ${polarity} | invalid=${this.invalidSamples} dropped=${this.droppedSamples} ` +
              `queue=${this.realECGQueue.length}`
            );
          }
        }
        this._resetWindowStats();
      }
    }
  }

  // ------------------------------------------------------------------
  // Статус-плашка и заглушка
  // ------------------------------------------------------------------

  _computeStatus(nowMs) {
    if (!this.hasStream) {
      return { key: 'idle', live: false, text: 'Ожидание', cls: PILL_SLATE };
    }
    if (this.allowSynthetic) {
      return { key: 'demo', live: true, text: 'ДЕМО 250 Гц', cls: PILL_AMBER };
    }

    if (this.leadsOff) {
      return { key: 'leads_off', live: false, text: 'Электроды не подключены', cls: PILL_RED };
    }

    const fresh = this.lastRealSampleTime > 0 && (nowMs - this.lastRealSampleTime < STALE_MS);
    if (!fresh) {
      return { key: 'waiting', live: false, text: 'Ожидание ЭКГ', cls: PILL_SKY };
    }

    const validFresh = this.lastValidSampleTime > 0 && (nowMs - this.lastValidSampleTime < VALID_FRESH_MS);
    if (!validFresh) {
      return { key: 'no_signal', live: false, text: 'Нет сигнала ЭКГ (ADC вне диапазона)', cls: PILL_RED };
    }

    if (this.measuredRateHz == null) {
      return { key: 'measuring', live: true, text: 'LIVE · измерение частоты…', cls: PILL_SKY };
    }

    const hz = Math.round(this.measuredRateHz);
    const deviation = Math.abs(this.measuredRateHz - SAMPLE_RATE_HZ) / SAMPLE_RATE_HZ;
    if (deviation <= RATE_TOLERANCE) {
      return { key: 'live', live: true, text: `LIVE ${hz} Гц`, cls: PILL_GREEN };
    }
    return { key: 'rate_off', live: true, text: `ЭКГ ${hz} Гц (ожидалось ${SAMPLE_RATE_HZ})`, cls: PILL_AMBER };
  }

  _applyStatus(item, nowMs) {
    if (!item.emptyState) {
      item.emptyState = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-empty-state' : 'ecg-empty-state');
    }
    if (!item.statusPill) {
      item.statusPill = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-status-pill' : 'ecg-status-pill');
    }

    const st = this._computeStatus(nowMs);
    const cacheKey = `${st.key}|${st.text}`;
    if (item._statusKey === cacheKey && item.emptyState && item.statusPill) return;
    item._statusKey = cacheKey;

    if (item.emptyState) {
      if (st.live) item.emptyState.classList.add('hidden');
      else item.emptyState.classList.remove('hidden');
    }
    if (item.statusPill) {
      item.statusPill.textContent = st.text;
      item.statusPill.className = st.cls;
    }
  }

  // ------------------------------------------------------------------
  // Демо-сигнал
  // ------------------------------------------------------------------

  /**
   * Генерация математически точной физиологической ЭКГ (P-Q-R-S-T)
   */
  generateSyntheticECG(t, bpm) {
    const beatPeriod = 60 / Math.max(40, bpm);
    const phase = (t % beatPeriod) / beatPeriod;
    let val = 0;

    // P-зубец (деполяризация предсердий)
    if (phase >= 0.12 && phase <= 0.20) {
      val += 0.16 * Math.sin((phase - 0.12) / 0.08 * Math.PI);
    }
    // Q-зубец (деполяризация перегородки)
    else if (phase >= 0.28 && phase <= 0.30) {
      val -= 0.14 * Math.sin((phase - 0.28) / 0.02 * Math.PI);
    }
    // R-зубец (главный пик деполяризации желудочков)
    else if (phase >= 0.30 && phase <= 0.34) {
      val += 1.18 * Math.sin((phase - 0.30) / 0.04 * Math.PI);
    }
    // S-зубец (отрицательное отклонение)
    else if (phase >= 0.34 && phase <= 0.38) {
      val -= 0.25 * Math.sin((phase - 0.34) / 0.04 * Math.PI);
    }
    // T-зубец (реполяризация желудочков)
    else if (phase >= 0.50 && phase <= 0.70) {
      val += 0.34 * Math.sin((phase - 0.50) / 0.20 * Math.PI);
    }

    // Изолиния и физиологический джиттер
    val += 0.03 * Math.sin(t * 1.5);
    val += (Math.random() - 0.5) * 0.02;
    return val;
  }

  refresh() {
    // Размеры буферов пересчитываются в loop() при изменении размера canvas
  }

  // ------------------------------------------------------------------
  // Выбор отсчётов на текущий кадр
  // ------------------------------------------------------------------

  _collectFrameSamples(dt) {
    // Демо: отсчёты по времени, 250 Гц
    if (this.allowSynthetic) {
      this.drainAccum += dt * SAMPLE_RATE_HZ;
      const n = Math.min(Math.floor(this.drainAccum), 60);
      this.drainAccum -= Math.floor(this.drainAccum);
      const bpm = this.currentBpm || 72;
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(this.generateSyntheticECG(this.synthT, bpm));
        this.synthT += 1 / SAMPLE_RATE_HZ;
      }
      return out;
    }

    // Реальный режим
    const qLen = this.realECGQueue.length;

    // Стартовый запас: пока не накопили целевую задержку, развёртку не двигаем
    if (this.buffering) {
      if (qLen >= TARGET_LATENCY_SAMPLES) this.buffering = false;
      else return [];
    }

    // Адаптивная скорость: очередь выше цели — читаем чуть быстрее, ниже — чуть медленнее.
    // Так задержка держится около цели, а ни один отсчёт не теряется.
    const err = qLen - TARGET_LATENCY_SAMPLES;
    const speed = Math.min(1.4, Math.max(0.8, 1 + err / 250));

    this.drainAccum += dt * SAMPLE_RATE_HZ * speed;
    let n = Math.floor(this.drainAccum);
    this.drainAccum -= n;
    if (n <= 0) return [];

    if (n >= qLen) {
      // Очередь опустела — ждём, пока накопится запас
      n = qLen;
      this.drainAccum = 0;
      this.buffering = true;
    }
    return this.realECGQueue.splice(0, n);
  }

  // ------------------------------------------------------------------
  // Главный цикл отрисовки
  // ------------------------------------------------------------------

  loop() {
    const nowMs = performance.now();
    const dt = this.lastFrameMs > 0
      ? Math.min(0.1, Math.max(0, (nowMs - this.lastFrameMs) / 1000))
      : 0;
    this.lastFrameMs = nowMs;

    this._updateRate(nowMs);

    const frameSamples = (this.hasStream && !this.isPaused)
      ? this._collectFrameSamples(dt)
      : [];

    this.canvases.forEach(item => {
      if (!item.canvas) item.canvas = document.getElementById(item.id);
      if (item.canvas && !item.ctx) item.ctx = item.canvas.getContext('2d');
      const { canvas, ctx } = item;
      if (!canvas || !ctx) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 10 || rect.height <= 10) return; // Скрытая вкладка

      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.floor(rect.width * dpr);
      const targetH = Math.floor(rect.height * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
      }

      const w = rect.width;
      const h = rect.height;
      const midY = h / 2;

      // Буфер хранит отсчёты (не пиксели): 1 ячейка = 1 отсчёт при 250 Гц
      const capacity = Math.max(16, Math.round(w * SAMPLE_RATE_HZ / PX_PER_SECOND));
      if (item.buffer.length !== capacity) {
        item.buffer = new Float32Array(capacity).fill(NaN);
        item.head = 0;
      }
      const xStep = w / capacity;

      // 1. Запись отсчётов кадра в буфер развёртки
      for (let i = 0; i < frameSamples.length; i++) {
        item.buffer[item.head] = frameSamples[i];
        item.head = (item.head + 1) % capacity;
      }

      // Заглушка и статус-плашка
      this._applyStatus(item, nowMs);

      // 2. Тёмный медицинский фон
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, w, h);

      // 3. Мелкая сетка (10px)
      ctx.strokeStyle = '#0d1824';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let x = 0; x < w; x += 10) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y < h; y += 10) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Крупная сетка (50px)
      ctx.strokeStyle = '#142a38';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 50) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y < h; y += 50) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      if (!this.hasStream) return;

      // 4. Стирающий зазор перед лучом
      const sweepX = item.head * xStep;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(sweepX, 0, SWEEP_GAP_PX, h);
      if (sweepX + SWEEP_GAP_PX > w) {
        ctx.fillRect(0, 0, sweepX + SWEEP_GAP_PX - w, h);
      }

      // 5. Кардиограмма с фосфорным свечением.
      // NaN-отсчёты (невалидный ADC) и зазор разрывают линию — без выдуманных данных.
      const gapSamples = Math.ceil(SWEEP_GAP_PX / xStep);
      ctx.strokeStyle = '#34d399';
      ctx.shadowColor = '#10b981';
      ctx.shadowBlur = 6;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < capacity; i++) {
        const dist = (i - item.head + capacity) % capacity;
        const v = item.buffer[i];
        if (dist < gapSamples || Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const x = i * xStep;
        const y = midY - v * (h * 0.38);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 6. Ведущая точка на последнем записанном отсчёте
      const lastIdx = (item.head - 1 + capacity) % capacity;
      const lastV = item.buffer[lastIdx];
      if (!Number.isNaN(lastV)) {
        ctx.fillStyle = '#6ee7b7';
        ctx.beginPath();
        ctx.arc(lastIdx * xStep, midY - lastV * (h * 0.38), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    this.animId = requestAnimationFrame(() => this.loop());
  }
}