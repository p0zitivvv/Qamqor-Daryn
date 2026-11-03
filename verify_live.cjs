async function verify() {
  try {
    const res = await fetch('https://qamqordaryn.vercel.app/?t=' + Date.now());
    const html = await res.text();
    console.log('HTML size:', html.length);
    console.log('Has embedded bundle:', html.includes('id="qamqor-unified-bundle"'));
    console.log('Has App.init:', html.includes('App.init'));
    console.log('Has getFormattedGuardianAlertMessage:', html.includes('getFormattedGuardianAlertMessage'));
    console.log('Has ECGCanvasService:', html.includes('ECGCanvasService'));
    console.log('Has DemoSimulator:', html.includes('DemoSimulator'));
  } catch(e) {
    console.error('Fetch error:', e);
  }
}
verify();
