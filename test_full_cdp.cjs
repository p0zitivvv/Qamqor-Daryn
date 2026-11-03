const { spawn } = require('child_process');

async function testFull() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1280,900',
    'about:blank'
  ]);

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch('http://127.0.0.1:9222/json');
        targets = await res.json();
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        console.log(`[LOG ${msg.params.type}]:`, msg.params.args.map(a => a.value || JSON.stringify(a)).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error(`[UNCAUGHT ERROR]:`, msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
      }
      if (callbacks.has(msg.id)) {
        callbacks.get(msg.id)(msg);
        callbacks.delete(msg.id);
      }
    };

    await new Promise(r => ws.onopen = r);

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const msgId = id++;
        callbacks.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');

    console.log('1. Loading https://qamqordaryn.vercel.app/ ...');
    await send('Page.navigate', { url: 'https://qamqordaryn.vercel.app/' });
    await new Promise(r => setTimeout(r, 2000));

    // Click safeStartDemo
    console.log('2. Starting demo mode...');
    let res = await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[onclick*="safeStartDemo"], #btn-quick-demo');
        if (btn) btn.click();
        return { clicked: !!btn };
      })()`,
      returnByValue: true
    });
    console.log('Clicked demo button:', res.result?.result?.value);

    // Wait 3 seconds for simulation ticks and animations to run
    console.log('3. Waiting 3 seconds for telemetry ticks & ECG render...');
    await new Promise(r => setTimeout(r, 3000));

    // Check Home Tab Telemetry & ECG Canvas
    res = await send('Runtime.evaluate', {
      expression: `(() => {
        const homeCanvas = document.getElementById('homeECGCanvas');
        let hasPixels = false;
        if (homeCanvas && homeCanvas.width > 0 && homeCanvas.height > 0) {
          try {
            const ctx = homeCanvas.getContext('2d');
            const data = ctx.getImageData(0, 0, homeCanvas.width, homeCanvas.height).data;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) {
                hasPixels = true;
                break;
              }
            }
          } catch(e) {
            hasPixels = 'error: ' + e.message;
          }
        }

        const bpm = document.getElementById('metric-bpm')?.textContent?.trim();
        const spo2 = document.getElementById('metric-spo2')?.textContent?.trim();
        const sdnn = document.getElementById('metric-sdnn')?.textContent?.trim();
        const indexVal = document.getElementById('risk-index-value')?.textContent?.trim();
        const simRunning = window.App?.demoSimulator?.isRunning;
        const ecgStreaming = window.App?.ecgCanvas?.hasStream;

        return {
          homeCanvasExists: !!homeCanvas,
          canvasWidth: homeCanvas?.width,
          canvasHeight: homeCanvas?.height,
          canvasHasPixels: hasPixels,
          bpm,
          spo2,
          sdnn,
          indexVal,
          simRunning,
          ecgStreaming
        };
      })()`,
      returnByValue: true
    });
    console.log('Home tab state:', res.result?.result?.value);

    // Test Tab Navigation with REAL IDs: home, metrics, factors, history, guardian, settings
    const navTabs = [
      { id: 'metrics', name: 'ЭКГ / Метрики' },
      { id: 'factors', name: 'Советы и факторы' },
      { id: 'history', name: 'История' },
      { id: 'guardian', name: 'Опекун' },
      { id: 'settings', name: 'Настройки' }
    ];

    for (const t of navTabs) {
      console.log(`\n4. Switching to tab: ${t.name} ('${t.id}')...`);
      res = await send('Runtime.evaluate', {
        expression: `(() => {
          safeSwitchTab('${t.id}');
          const tabEl = document.getElementById('tab-${t.id}');
          const isVisible = tabEl && !tabEl.classList.contains('hidden') && tabEl.style.display !== 'none';

          let extraInfo = {};
          if ('${t.id}' === 'metrics') {
            const mc = document.getElementById('liveECGCanvas');
            let mPixels = false;
            if (mc && mc.width > 0 && mc.height > 0) {
              const ctx = mc.getContext('2d');
              const data = ctx.getImageData(0, 0, mc.width, mc.height).data;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) { mPixels = true; break; }
              }
            }
            extraInfo = { liveECGExists: !!mc, liveECGWidth: mc?.width, liveECGHeight: mc?.height, liveECGHasPixels: mPixels };
          } else if ('${t.id}' === 'factors') {
            const list = document.getElementById('recommendations-list');
            extraInfo = { itemsCount: list?.children?.length || 0, textPreview: tabEl?.innerText?.slice(0, 100) };
          } else if ('${t.id}' === 'guardian') {
            const statusEl = document.getElementById('guardian-status-display');
            const tgInput = document.getElementById('guardian-tg-chat-id');
            const alertCards = tabEl.querySelectorAll('.rounded-xl, .rounded-2xl');
            extraInfo = {
              hasTgInput: !!tgInput,
              cardCount: alertCards.length,
              statusText: statusEl?.innerText || 'N/A',
              preview: tabEl.innerText.slice(0, 150)
            };
          } else if ('${t.id}' === 'history') {
            const historyList = document.getElementById('history-list');
            extraInfo = { historyListCount: historyList?.children?.length || 0, preview: tabEl.innerText.slice(0, 100) };
          }

          return { isVisible, extraInfo };
        })()`,
        returnByValue: true
      });
      console.log(`Result for ${t.name}:`, JSON.stringify(res.result?.result?.value, null, 2));
      await new Promise(r => setTimeout(r, 800));
    }

    // Now on Guardian tab, test Telegram alert generation preview & verify button
    console.log('\n5. Testing Guardian Tab interactions...');
    res = await send('Runtime.evaluate', {
      expression: `(() => {
        const previewEl = document.getElementById('guardian-tg-preview');
        const alertBtn = document.querySelector('button[onclick*="triggerGuardianAlert"]');
        const verifyBtn = document.querySelector('button[onclick*="verifyTelegramDelivery"]');
        return {
          hasPreviewEl: !!previewEl,
          previewText: previewEl?.innerText?.slice(0, 200),
          hasAlertBtn: !!alertBtn,
          hasVerifyBtn: !!verifyBtn
        };
      })()`,
      returnByValue: true
    });
    console.log('Guardian controls check:', res.result?.result?.value);

    // Return to Metrics tab to verify liveECGCanvas after tab switch
    console.log('\n6. Checking ECG canvas active rendering on Metrics tab...');
    await send('Runtime.evaluate', { expression: `safeSwitchTab('metrics');` });
    await new Promise(r => setTimeout(r, 1500));
    res = await send('Runtime.evaluate', {
      expression: `(() => {
        const mc = document.getElementById('liveECGCanvas');
        let mPixels = false;
        if (mc && mc.width > 0 && mc.height > 0) {
          const ctx = mc.getContext('2d');
          const data = ctx.getImageData(0, 0, mc.width, mc.height).data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) { mPixels = true; break; }
          }
        }
        return {
          tabVisible: !document.getElementById('tab-metrics')?.classList.contains('hidden'),
          canvasWidth: mc?.width,
          canvasHeight: mc?.height,
          canvasHasPixels: mPixels,
          streamActive: window.App?.ecgCanvas?.hasStream
        };
      })()`,
      returnByValue: true
    });
    console.log('Metrics tab ECG status:', res.result?.result?.value);

    ws.close();
  } catch (e) {
    console.error('Test error:', e);
  } finally {
    chromeProc.kill();
  }
}

testFull().catch(console.error);
