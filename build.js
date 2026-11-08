import fs from 'node:fs';
import path from 'node:path';

const files = [
  'config.js',
  'signals.js',
  'model.js',
  'quality.js',
  'baseline.js',
  'alerts.js',
  'knowledge_base.js',
  'recommendations.js',
  'storage.js',
  'ai_advisor.js',
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

// 3. Создание директорий dist и public для 100% совместимости с любыми настройками Vercel
const targetDirs = [path.join(process.cwd(), 'dist'), path.join(process.cwd(), 'public')];

for (const targetDir of targetDirs) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Запись файлов
  fs.writeFileSync(path.join(targetDir, 'bundle.js'), bundleContent, 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexHtml, 'utf-8');

  const copyFiles = ['sw.js', 'manifest.json', 'vercel.json', 'robots.txt', 'sitemap.xml'];
  for (const f of copyFiles) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(targetDir, f));
    }
  }

  // Копирование js/
  const targetJsDir = path.join(targetDir, 'js');
  if (!fs.existsSync(targetJsDir)) {
    fs.mkdirSync(targetJsDir, { recursive: true });
  }
  const jsFiles = fs.readdirSync('js');
  for (const jf of jsFiles) {
    fs.copyFileSync(path.join('js', jf), path.join(targetJsDir, jf));
  }

  // Копирование api/
  if (fs.existsSync('api')) {
    const targetApiDir = path.join(targetDir, 'api');
    if (!fs.existsSync(targetApiDir)) {
      fs.mkdirSync(targetApiDir, { recursive: true });
    }
    const apiFiles = fs.readdirSync('api');
    for (const af of apiFiles) {
      fs.copyFileSync(path.join('api', af), path.join(targetApiDir, af));
    }
  }
}
console.log('dist and public directories prepared successfully with all static assets!');

