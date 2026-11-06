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
      
      const hasLiveStream = active && (this.allowSynthetic || this.realECGQueue.length > 0);
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
        } else if (this.realECGQueue.length > 0) {
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
    // Нормализация 12-битного ADC (0..4095) в диапазон [-1, 1] относительно центра 2048
    const normalized = (adcValue - 2048) / 1024.0;
    this.realECGQueue.push(normalized);
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
    const now = performance.now() / 1000;

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

      // Генерация или считывание отсчета
      if (this.hasStream && !this.isPaused) {
        let sample = 0;
        let hasSample = false;

        if (this.realECGQueue.length > 0) {
          sample = this.realECGQueue.shift();
          hasSample = true;
        } else if (this.allowSynthetic) {
          sample = this.generateSyntheticECG(now, this.currentBpm || 72);
          hasSample = true;
        }

        const midY = h / 2;
        const y = hasSample ? (midY - (sample * (h * 0.38))) : midY;

        const curX = Math.floor(item.sweepX);
        item.buffer[curX] = y;
        if (curX + 1 < item.buffer.length) {
          item.buffer[curX + 1] = y;
        }
        item.sweepX = (item.sweepX + 2) % w;

        // Обновляем видимость заглушки при появлении реального потока
        if (item.emptyState) {
          if (hasSample) item.emptyState.classList.add('hidden');
          else item.emptyState.classList.remove('hidden');
        }
      }

      // 1. Отрисовка темного медицинского фона
      ctx.fillStyle = '#060b13';
      ctx.fillRect(0, 0, w, h);

      // 2. Мелкая медицинская сетка (10px)
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

      // 3. Стирающий луч (Sweep erase bar)
      if (this.hasStream) {
        const gap = 24;
        ctx.fillStyle = '#060b13';
        ctx.fillRect(item.sweepX, 0, gap, h);

        // 4. Кардиограмма с фосфорным свечением
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
          const y = item.buffer[x] || (h / 2);
          if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 5. Ведущая точка
        const curY = item.buffer[Math.floor(item.sweepX)] || (h / 2);
        ctx.fillStyle = '#6ee7b7';
        ctx.beginPath();
        ctx.arc(item.sweepX, curY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    this.animId = requestAnimationFrame(() => this.loop());
  }
}
