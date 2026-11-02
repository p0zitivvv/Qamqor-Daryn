import http from 'http';

http.get('http://localhost:9222/json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const list = JSON.parse(data);
    const page = list.find(p => p.url && p.url.includes('index.html'));
    if (!page) { console.error('index.html not found'); process.exit(1); }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: `
            App.setSurveyChoice('smoking', 0);
            JSON.stringify({
              smoking: App.state.surveyTemp.smoking,
              btn0Class: document.getElementById('opt-smoking-0').className
            });
          `
        }
      }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 2) {
        console.log('RESULT OF setSurveyChoice:', msg.result);
        process.exit(0);
      }
    };
  });
});
