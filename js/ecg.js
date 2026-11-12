/**
 * Qamqor Health Monitoring System
 * Модуль осциллографа ЭКГ на HTML5 Canvas (ECG Oscilloscope)
 * Реализация спецификации раздела 7.2 и 11
 */

export class ECGCanvasService {
  constructor() {
    this.canvases = [];
    this.animId = null;
    this.hasStream = false;
    this.isPaused = false;
    this.currentBpm = 72;
    this.realECGQueue = [];
    this.allowSynthetic = false;
    this.lastRealSampleTime = 0;

    // Цифровая фильтрация и масштабирование реального AD8232 (250 Гц)
    this.baselineEMA = 2048.0;         // Следящая изолиния (High-Pass ~0.5 Гц)
    this.baselineInitialized = false;
    this.lpFiltered = 0.0;             // Низкочастотный IIR-фильтр (~40 Гц, срез 50 Гц помехи)
    this.peakSpanEMA = 350.0;          // Динамический диапазон для адаптивного усиления (AGC)

    // Синхронизация развертки и интерполяция формы волны
    this.lastNormalizedSample = 0.0;   // Последний нормализованный отсчет
    this.prevRenderedSample = 0.0;     // Предыдущий отрендеренный отсчет для интерполяции
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
          buffer: [],
          sweepX: 0
        });
      }
    });

    window.addEventListener('resize', () => this.refresh());
    if (!this.animId) {
      this.loop();
    }
  }

  setStreamActive(active, allowSynthetic = false) {
    this.hasStream = active;
    this.allowSynthetic = allowSynthetic;
    if (!active) {
      this.realECGQueue = [];
      this.lastNormalizedSample = 0.0;
      this.prevRenderedSample = 0.0;
      this.baselineInitialized = false;
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
    this.canvases.forEach(item => {
      if (!item.emptyState) item.emptyState = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-empty-state' : 'ecg-empty-state');
      if (!item.statusPill) item.statusPill = document.getElementById(item.id === 'homeECGCanvas' ? 'home-ecg-status-pill' : 'ecg-status-pill');
      
      const isRecentlyActive = this.allowSynthetic || (this.lastRealSampleTime > 0 && (performance.now() - this.lastRealSampleTime < 3500)) || this.realECGQueue.length > 0;
      const hasLiveStream = active && isRecentlyActive;
      if (item.emptyState) {
        if (hasLiveStream) item.emptyState.classList.add('hidden');
        else item.emptyState.classList.remove('hidden');
      }
      if (item.statusPill) {
        if (!active) {
          item.statusPill.textContent = 'Ожидание';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 font-medium';
        } else if (this.allowSynthetic) {
          item.statusPill.textContent = 'ДЕМО 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-mono font-semibold';
        } else if (isRecentlyActive) {
          item.statusPill.textContent = 'LIVE 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono font-semibold';
        } else {
          item.statusPill.textContent = 'Ожидание ЭКГ';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 font-mono font-medium';
        }
      }
    });
  }

  setBPM(bpm) {
    if (typeof bpm === 'number' && bpm > 30) {
      this.currentBpm = bpm;
    }
  }

  pushRealSample(adcValue) {
    if (typeof adcValue !== 'number' || !Number.isFinite(adcValue)) return;

    // При первом запуске или после длинной паузы мгновенно инициализируем изолинию
    const now = performance.now();
    if (!this.baselineInitialized || (this.lastRealSampleTime > 0 && (now - this.lastRealSampleTime > 3000))) {
      this.baselineEMA = adcValue;
      this.lpFiltered = 0.0;
      this.baselineInitialized = true;
    }

    // 1. Адаптивное удаление постоянной составляющей (DC Drift & Baseline Wander Filter ~0.5 Гц)
    // Устраняет разброс опорного напряжения AD8232 (1.4В - 2.0В) и артефакты дыхания
    this.baselineEMA += (adcValue - this.baselineEMA) * 0.008;
    const acSignal = adcValue - this.baselineEMA;

    // 2. IIR Низкочастотный фильтр (~40 Гц при частоте дискретизации 250 Гц)
    // Подавляет сетевую наводку 50 Гц и высокочастотный миографический шум (EMG),
    // сохраняя физиологическую форму комплексов P-Q-R-S-T без прямоугольных скачков
    this.lpFiltered += (acSignal - this.lpFiltered) * 0.42;

    // 3. Автоматическая подстройка масштаба (Dynamic Gain Control)
    const absVal = Math.abs(this.lpFiltered);
    if (absVal > this.peakSpanEMA) {
      this.peakSpanEMA = this.peakSpanEMA * 0.95 + absVal * 0.05;
    } else {
      this.peakSpanEMA = Math.max(120.0, this.peakSpanEMA * 0.9995);
    }

    // 4. Нормализация сигнала в физиологический диапазон [-1.0, 1.0]
    const scaleFactor = Math.max(160.0, this.peakSpanEMA * 1.35);
    let norm = this.lpFiltered / scaleFactor;

    // Мягкое скругление (soft limiter) вместо прямоугольного клиппинга на краях
    if (norm > 1.25) norm = 1.25 + Math.tanh(norm - 1.25) * 0.25;
    if (norm < -1.25) norm = -1.25 + Math.tanh(norm + 1.25) * 0.25;

    this.realECGQueue.push(norm);
    this.lastRealSampleTime = now;
    if (this.realECGQueue.length > 500) {
      this.realECGQueue.shift();
    }
  }

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
    // Пересчет размеров буфера
  }

  loop() {
    const nowMs = performance.now();
    const nowSec = nowMs / 1000;

    // Шаг развертки за 1 кадр анимации (2 пикселя обеспечивают медицинскую скорость ~25 мм/с при 60 FPS)
    const stepPixels = 2;
    const frameSamples = [];

    const isRecentlyActive = this.allowSynthetic || (this.lastRealSampleTime > 0 && (nowMs - this.lastRealSampleTime < 3500)) || this.realECGQueue.length > 0;

    if (this.hasStream && !this.isPaused) {
      if (this.allowSynthetic) {
        // Демо-режим: генерация синтетических отсчетов
        const bpm = this.currentBpm || 72;
        for (let i = 0; i < stepPixels; i++) {
          const t = nowSec + (i * 0.008);
          frameSamples.push(this.generateSyntheticECG(t, bpm));
        }
        this.lastNormalizedSample = frameSamples[frameSamples.length - 1];
        this.prevRenderedSample = this.lastNormalizedSample;
      } else if (this.realECGQueue.length > 0) {
        // Реальный режим: извлечение реальных отсчетов AD8232
        // При 250 Гц на 60 FPS приходится ~4.1 отсчета за кадр.
        // Забираем отсчеты с учетом заполнения очереди для исключения лага:
        const qLen = this.realECGQueue.length;
        const drainCount = qLen > 30 ? Math.min(qLen, 5) : (qLen >= stepPixels ? stepPixels : 1);

        for (let i = 0; i < drainCount; i++) {
          if (this.realECGQueue.length > 0) {
            this.lastNormalizedSample = this.realECGQueue.shift();
          }
        }

        // Интерполируем значения на stepPixels пикселей для безупречно гладкой кривой
        const prev = this.prevRenderedSample ?? this.lastNormalizedSample;
        const target = this.lastNormalizedSample;
        for (let i = 0; i < stepPixels; i++) {
          const factor = (i + 1) / stepPixels;
          frameSamples.push(prev + (target - prev) * factor);
        }
        this.prevRenderedSample = target;
      } else {
        // Очередь пуста между BLE-пакетами:
        // КРИТИЧЕСКИ ВАЖНО: НЕ сбрасываем в midY (0)! Плавно удерживаем сигнал
        // с медленным дрейфом к изолинии, исключая прямоугольные провалы.
        if (isRecentlyActive) {
          this.lastNormalizedSample *= 0.985;
          frameSamples.push(this.lastNormalizedSample);
          frameSamples.push(this.lastNormalizedSample);
          this.prevRenderedSample = this.lastNormalizedSample;
        } else {
          this.lastNormalizedSample = 0;
          frameSamples.push(0);
          frameSamples.push(0);
          this.prevRenderedSample = 0;
        }
      }
    }

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

      const neededPoints = Math.ceil(w);
      if (item.buffer.length !== neededPoints) {
        item.buffer = new Array(neededPoints).fill(h / 2);
        item.sweepX = 0;
      }

      if (isNaN(item.sweepX) || item.sweepX >= w) {
        item.sweepX = 0;
      }

      const midY = h / 2;

      // 1. Запись отсчетов текущего кадра в буфер развертки
      if (this.hasStream && !this.isPaused && frameSamples.length > 0) {
        for (let i = 0; i < frameSamples.length; i++) {
          const sample = frameSamples[i];
          const y = midY - (sample * (h * 0.38));
          const curX = (Math.floor(item.sweepX) + i) % w;
          item.buffer[curX] = y;
        }
        item.sweepX = (item.sweepX + frameSamples.length) % w;
      }

      // Обновляем видимость заглушки при появлении реального потока
      if (item.emptyState) {
        if (this.hasStream && isRecentlyActive) {
          item.emptyState.classList.add('hidden');
        } else {
          item.emptyState.classList.remove('hidden');
        }
      }
      if (item.statusPill) {
        if (!this.hasStream) {
          item.statusPill.textContent = 'Ожидание';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 font-medium';
        } else if (this.allowSynthetic) {
          item.statusPill.textContent = 'ДЕМО 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-mono font-semibold';
        } else if (isRecentlyActive) {
          item.statusPill.textContent = 'LIVE 250 Гц';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono font-semibold';
        } else {
          item.statusPill.textContent = 'Ожидание ЭКГ';
          item.statusPill.className = 'text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 font-mono font-medium';
        }
      }

      // 2. Отрисовка темного медицинского фона
      ctx.fillStyle = '#060b13';
      ctx.fillRect(0, 0, w, h);

      // 3. Мелкая медицинская сетка (10px)
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

      // Крупная медицинская сетка (50px)
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

      // 4. Стирающий луч (Sweep erase bar)
      if (this.hasStream) {
        const gap = 24;
        ctx.fillStyle = '#060b13';
        ctx.fillRect(item.sweepX, 0, gap, h);

        // 5. Кардиограмма с фосфорным свечением (гладкие соединения)
        ctx.strokeStyle = '#34d399';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 6;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        let drawing = false;
        for (let x = 0; x < w; x++) {
          if (x >= item.sweepX && x < item.sweepX + gap) {
            drawing = false;
            continue;
          }
          const y = item.buffer[x] != null ? item.buffer[x] : midY;
          if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 6. Ведущая точка
        const curY = item.buffer[Math.floor(item.sweepX)] || midY;
        ctx.fillStyle = '#6ee7b7';
        ctx.beginPath();
        ctx.arc(item.sweepX, curY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    this.animId = requestAnimationFrame(() => this.loop());
  }

    this.animId = requestAnimationFrame(() => this.loop());
  }
}
