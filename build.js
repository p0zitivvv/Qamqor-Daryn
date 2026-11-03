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

// 1. Запись bundle.js в корень проекта
fs.writeFileSync('bundle.js', bundleContent, 'utf-8');
console.log('bundle.js generated successfully! Size:', bundleContent.length, 'bytes');

// 2. Встраивание бандла прямо в index.html для 100% защиты от 404 на Vercel/хостингах
let indexHtml = fs.readFileSync('index.html', 'utf-8');
const bundleScriptRegex = /<script(?:\s+id="qamqor-unified-bundle"[^>]*>[\s\S]*?<\/script>|\s+src=["']\.\/bundle\.js[^"']*["']><\/script>)/;

const inlinedScriptTag = `<script id="qamqor-unified-bundle">\n${bundleContent}\n</script>`;

if (bundleScriptRegex.test(indexHtml)) {
  indexHtml = indexHtml.replace(bundleScriptRegex, inlinedScriptTag);
  fs.writeFileSync('index.html', indexHtml, 'utf-8');
  console.log('index.html updated with inlined bundle (zero-404 guaranteed)!');
} else {
  console.warn('Warning: Could not find bundle script tag in index.html to inline');
}

// 3. Создание директории dist для совместимости с любыми настройками Vercel
const distDir = path.join(process.cwd(), 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Запись файлов в dist
fs.writeFileSync(path.join(distDir, 'bundle.js'), bundleContent, 'utf-8');
fs.writeFileSync(path.join(distDir, 'index.html'), indexHtml, 'utf-8');

const copyFiles = ['sw.js', 'manifest.json', 'vercel.json'];
for (const f of copyFiles) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, path.join(distDir, f));
  }
}

// Копирование js/ в dist/js
const distJsDir = path.join(distDir, 'js');
if (!fs.existsSync(distJsDir)) {
  fs.mkdirSync(distJsDir, { recursive: true });
}
const jsFiles = fs.readdirSync('js');
for (const jf of jsFiles) {
  fs.copyFileSync(path.join('js', jf), path.join(distJsDir, jf));
}
console.log('dist directory prepared successfully with all static assets!');

