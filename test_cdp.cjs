const { spawn } = require('child_process');
const http = require('http');

async function main() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank'
  ]);

  try {
    // Wait for chrome to be ready
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch('http://127.0.0.1:9222/json');
        targets = await res.json();
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    if (!targets) {
      console.error('Could not connect to Chrome CDP');
      return;
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('Page target found:', pageTarget.webSocketDebuggerUrl);

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        console.log(`[BROWSER CONSOLE ${msg.params.type}]:`, msg.params.args.map(a => a.value || a.description).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error(`[BROWSER UNCAUGHT EXCEPTION]:`, msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
      }
      if (callbacks.has(msg.id)) {
        callbacks.get(msg.id)(msg);
        callbacks.delete(msg.id);
      }
    };

    await new Promise((resolve) => ws.onopen = resolve);

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const msgId = id++;
        callbacks.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');

    console.log('Navigating to https://qamqordaryn.vercel.app/ ...');
    await send('Page.navigate', { url: 'https://qamqordaryn.vercel.app/' });
    await new Promise(r => setTimeout(r, 2000));

    // Evaluate state of page
    let res = await send('Runtime.evaluate', {
      expression: `({
        title: document.title,
        hasApp: typeof App !== 'undefined',
        hasECG: typeof ECGCanvasService !== 'undefined',
        activeScreen: document.querySelector('.screen.active')?.id || 'none',
        hasSafeSwitchTab: typeof safeSwitchTab === 'function'
      })`,
      returnByValue: true
    });
    console.log('Initial page state:', res.result?.result?.value);

    // Try starting demo
    console.log('Clicking quick demo button...');
    res = await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[onclick*="startDemoQuick"], button[onclick*="safeStartDemo"], #btn-quick-demo');
        if (btn) {
          btn.click();
          return { clicked: true, onclick: btn.getAttribute('onclick'), text: btn.textContent.trim() };
        }
        return { clicked: false };
      })()`,
      returnByValue: true
    });
    console.log('Quick demo click result:', res.result?.result?.value);

    await new Promise(r => setTimeout(r, 1000));

    // Check screen after click
    res = await send('Runtime.evaluate', {
      expression: `({
        activeScreen: document.querySelector('.screen.active')?.id,
        mainAppVisible: document.getElementById('screen-main-app')?.classList.contains('active'),
        homeECGCanvasVisible: !!(document.getElementById('homeECGCanvas')?.offsetParent),
        activeTab: document.querySelector('.tab-content.active')?.id
      })`,
      returnByValue: true
    });
    console.log('State after quick demo click:', res.result?.result?.value);

    // Test clicking navigation tabs
    const tabs = ['tab-home', 'tab-metrics', 'tab-recommendations', 'tab-history', 'tab-guardian', 'tab-settings'];
    for (const tab of tabs) {
      console.log(`\nTesting switch to tab: ${tab}...`);
      res = await send('Runtime.evaluate', {
        expression: `(() => {
          if (typeof safeSwitchTab === 'function') {
            safeSwitchTab('${tab}');
          } else if (typeof App !== 'undefined' && App.switchTab) {
            App.switchTab('${tab}');
          }
          const activeTabEl = document.querySelector('.tab-content.active');
          const ecgCanvas = document.getElementById('liveECGCanvas');
          const guardianTab = document.getElementById('tab-guardian');
          return {
            activeTabId: activeTabEl?.id,
            ecgCanvasExists: !!ecgCanvas,
            guardianTextLength: guardianTab?.innerText?.length || 0,
            guardianInnerHTMLPreview: guardianTab?.innerHTML?.slice(0, 100)
          };
        })()`,
        returnByValue: true
      });
      console.log(`Result for ${tab}:`, res.result?.result?.value);
      await new Promise(r => setTimeout(r, 500));
    }

    ws.close();
  } catch (err) {
    console.error('Error running test:', err);
  } finally {
    chromeProc.kill();
  }
}

main().catch(console.error);
