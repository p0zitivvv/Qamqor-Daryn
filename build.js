import fs from 'node:fs';
import path from 'node:path';

const files = [
  'config.js',
  'signals.js',
  'model.js',
  'quality.js',
  'baseline.js',
  'alerts.js',
  'recommendations.js',
  'storage.js',
  'ble.js',
  'simulator.js',
  'ecg.js',
  'app.js'
];

let bundleContent = '// Qamqor Unified Bundle for local file:// and web server compatibility\n(function() {\n';

for (const file of files) {
  const filePath = path.join('js', file);
  let src = fs.readFileSync(filePath, 'utf-8');

  // Удаляем multiline и singleline import ... from ...
  src = src.replace(/import\s+(?:\{[^}]*\}|[^{};\n]+)\s+from\s+['"][^'"]+['"];?/gs, '');
  // Удаляем import './...'
  src = src.replace(/import\s+['"][^'"]+['"];?/g, '');
  // Заменяем export default на обычное объявление
  src = src.replace(/^\s*export\s+default\s+/gm, '');
  // Заменяем export const/function/class на обычное const/function/class
  src = src.replace(/^\s*export\s+(const|let|var|function|class)\s+/gm, '$1 ');
  // Заменяем export { ... }
  src = src.replace(/export\s+\{[^}]*\};?/gs, '');

  bundleContent += `\n// --- ${file} ---\n` + src + '\n';
}

bundleContent += '\n})();\n';

fs.writeFileSync('bundle.js', bundleContent, 'utf-8');
console.log('bundle.js generated successfully! Size:', bundleContent.length, 'bytes');
