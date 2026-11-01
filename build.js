/**
 * build.js
 * 
 * 本地極速雙模構建腳本（零外部依賴）
 * 
 * 一鍵生成兩套部署產物：
 * 1. 【GitHub Pages CDN 模式】(推薦，載入速度提升 2~3 倍)：
 *    - dist/assets/styles.min.css (壓縮樣式檔，約 25 KB，上傳至 GitHub assets/ 目錄)
 *    - dist/assets/app.min.js     (壓縮腳本檔，約 104 KB，上傳至 GitHub assets/ 目錄)
 *    - dist/gas_index.html        (GAS 超輕量骨架，僅約 25 KB / 650 行，複製貼至 Apps Script index.html)
 * 
 * 2. 【單體發布模式】(根目錄 index.html，離線單元測試與單檔備援)：
 *    - index.html (完整內嵌 6,500 行代碼，100% 離線可用)
 * 
 * 執行方式：
 *   node build.js
 */

const fs = require('fs');
const path = require('path');

const startTime = Date.now();

const ROOT_DIR = __dirname;
const SRC_DIR = path.join(ROOT_DIR, 'src');
const JS_DIR = path.join(SRC_DIR, 'js');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

// GitHub Pages 基礎設定 (對應 hsnu125739/campus-attendance)
const GITHUB_USER = 'hsnu125739';
const GITHUB_REPO = 'campus-attendance';
const CDN_BASE_URL = `https://${GITHUB_USER}.github.io/${GITHUB_REPO}/assets`;

// 建立 dist 與 assets 輸出目錄
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// 1. 讀取 HTML 骨架與樣式
const templatePath = path.join(SRC_DIR, 'template.html');
const stylesPath = path.join(SRC_DIR, 'styles.css');

if (!fs.existsSync(templatePath)) {
  console.error('❌ 找不到 HTML 樣板檔案: ' + templatePath);
  process.exit(1);
}
if (!fs.existsSync(stylesPath)) {
  console.error('❌ 找不到樣式檔案: ' + stylesPath);
  process.exit(1);
}

const templateContent = fs.readFileSync(templatePath, 'utf8');
const stylesContent = fs.readFileSync(stylesPath, 'utf8');

// 2. 按嚴格依賴拓撲順序載入 JS 模組
const jsModules = [
  'attendance_store.js', // 點名出席深模組類別定義（無外部依賴）
  'member_store.js',     // 人員管理同步與記憶體合併深模組類別定義（無外部依賴）
  'campus_store.js',     // 小排管理排序與同步深模組類別定義（無外部依賴）
  'stats_aggregator.js', // 統計計算與時間軸深模組（純資料運算、無外部依賴）
  'core.js',             // 狀態定義、工具函式、RPC Client、Store 實例化
  'campuses.js',         // 首頁校園清單、卡片渲染、拖曳排序、小排管理
  'stats.js',            // 數據趨勢頁面、時間軸控制、Chart.js 圖表、KPI 計算與對比表
  'attendance.js',       // 點名頁面導航、成員卡片、打卡操作、一鍵預設、人員維護
  'ui.js'                // 篩選晶片、說明彈窗、事件委派、虛擬鍵盤修復、離場防護、啟動入口
];

const jsContents = [];
for (const mod of jsModules) {
  const modPath = path.join(JS_DIR, mod);
  if (!fs.existsSync(modPath)) {
    console.error('❌ 找不到 JS 模組: ' + modPath);
    process.exit(1);
  }
  jsContents.push(fs.readFileSync(modPath, 'utf8'));
}

const combinedScripts = jsContents.join('\n\n');

// 3. 壓縮輔助函式（純 JS 零外部依賴）
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 移除多行註解
    .replace(/\s+/g, ' ')                   // 連續空白收斂為單一空格
    .replace(/\s*([\{\}\;])\s*/g, '$1')     // 移除 { } ; 周圍空白 (保留冒號前空白，避免破壞子代選擇器如 .edit-mode :is(...))
    .replace(/:\s+/g, ':')                  // 移除屬性冒號後的空白
    .replace(/,\s+/g, ',')                  // 移除逗號後的空白
    .replace(/\;([\}])/g, '$1')             // 移除最後分號
    .trim();
}

function minifyJs(code) {
  let inString = null;
  let inBlockComment = false;
  let inLineComment = false;
  let escape = false;
  let result = '';

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (escape) {
      escape = false;
      result += ch;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      result += ch;
      continue;
    }

    if (inString) {
      if (ch === inString) inString = null;
      result += ch;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      result += ch;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

const minifiedCss = minifyCss(stylesContent);
const minifiedJs = minifyJs(combinedScripts);

// 產生帶有日期與秒數的防快取版本號 (Cache-busting Version)
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const versionTag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

// 4. 輸出產物 A：dist/gas/ (Google Apps Script 模組化部署檔：雙檔併行)
const GAS_DIR = path.join(DIST_DIR, 'gas');
if (!fs.existsSync(GAS_DIR)) fs.mkdirSync(GAS_DIR, { recursive: true });

// 4.1. dist/gas/index.html (開發/維護版骨架，引入 styles 與 scripts)
let gasIndexHtml = templateContent;
gasIndexHtml = gasIndexHtml.replace(/<style>\s*\/\*\s*@INJECT_STYLES\s*\*\/\s*<\/style>/, "<?!= include('styles'); ?>");
gasIndexHtml = gasIndexHtml.replace(/\s*\/\*\s*@INJECT_SCRIPTS\s*\*\/\s*<\/script>/, "\n  </script>\n  <?!= include('scripts'); ?>");
fs.writeFileSync(path.join(GAS_DIR, 'index.html'), gasIndexHtml, 'utf8');

// 4.2. dist/gas/index.min.html (正式發布版骨架，不壓縮骨架排版，引入 styles.min 與 scripts.min)
let gasIndexMinHtml = templateContent;
gasIndexMinHtml = gasIndexMinHtml.replace(/<style>\s*\/\*\s*@INJECT_STYLES\s*\*\/\s*<\/style>/, "<?!= include('styles.min'); ?>");
gasIndexMinHtml = gasIndexMinHtml.replace(/\s*\/\*\s*@INJECT_SCRIPTS\s*\*\/\s*<\/script>/, "\n  </script>\n  <?!= include('scripts.min'); ?>");
fs.writeFileSync(path.join(GAS_DIR, 'index.min.html'), gasIndexMinHtml, 'utf8');

// 4.3. dist/gas/styles.html 與 dist/gas/styles.min.html (樣式檔)
const gasStylesHtml = `<style>\n${stylesContent}\n</style>\n`;
fs.writeFileSync(path.join(GAS_DIR, 'styles.html'), gasStylesHtml, 'utf8');

const gasStylesMinHtml = `<style>\n${minifiedCss}\n</style>\n`;
fs.writeFileSync(path.join(GAS_DIR, 'styles.min.html'), gasStylesMinHtml, 'utf8');

// 4.4. dist/gas/scripts.html 與 dist/gas/scripts.min.html (腳本檔：第三方 CDN + 自訂模組合併)
const CHART_JS_CDN = `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>`;
const gasScriptsHtml = `${CHART_JS_CDN}\n<script>\n${combinedScripts}\n</script>\n`;
fs.writeFileSync(path.join(GAS_DIR, 'scripts.html'), gasScriptsHtml, 'utf8');

const gasScriptsMinHtml = `${CHART_JS_CDN}\n<script>\n${minifiedJs}\n</script>\n`;
fs.writeFileSync(path.join(GAS_DIR, 'scripts.min.html'), gasScriptsMinHtml, 'utf8');

// 5. 輸出產物 B：根目錄 index.html (單體完整版，離線單元測試與單檔備援)
let bundleHtml = templateContent;
bundleHtml = bundleHtml.replace('/* @INJECT_STYLES */', '\n' + stylesContent + '\n  ');
bundleHtml = bundleHtml.replace('/* @INJECT_SCRIPTS */', '\n' + combinedScripts + '\n  ');
bundleHtml = bundleHtml.replace('</head>', `  ${CHART_JS_CDN}\n</head>`);
fs.writeFileSync(path.join(ROOT_DIR, 'index.html'), bundleHtml, 'utf8');

const elapsed = Date.now() - startTime;
const bundleLines = bundleHtml.split(/\r?\n/).length;

const gasIndexLines = gasIndexHtml.split(/\r?\n/).length;
const gasIndexKb = (Buffer.byteLength(gasIndexHtml, 'utf8') / 1024).toFixed(1);
const gasIndexMinKb = (Buffer.byteLength(gasIndexMinHtml, 'utf8') / 1024).toFixed(1);

const gasStylesLines = gasStylesHtml.split(/\r?\n/).length;
const gasStylesKb = (Buffer.byteLength(gasStylesHtml, 'utf8') / 1024).toFixed(1);
const gasStylesMinLines = gasStylesMinHtml.split(/\r?\n/).length;
const gasStylesMinKb = (Buffer.byteLength(gasStylesMinHtml, 'utf8') / 1024).toFixed(1);

const gasScriptsLines = gasScriptsHtml.split(/\r?\n/).length;
const gasScriptsKb = (Buffer.byteLength(gasScriptsHtml, 'utf8') / 1024).toFixed(1);
const gasScriptsMinLines = gasScriptsMinHtml.split(/\r?\n/).length;
const gasScriptsMinKb = (Buffer.byteLength(gasScriptsMinHtml, 'utf8') / 1024).toFixed(1);

console.log('========================================================');
console.log('✅ [BUILD SUCCESS] 建置完成！(耗時 ' + elapsed + ' ms)');
console.log('========================================================\n');

console.log('🌐 【Google Apps Script 雙檔併行發布檔】(dist/gas/)：');
console.log('─── A. 開發／維護版 (完整註解與結構，易讀好除錯)：');
console.log(`   1. dist/gas/index.html       (${gasIndexLines} 行, ${gasIndexKb} KB) ──► 引入 styles 與 scripts`);
console.log(`   2. dist/gas/styles.html      (${gasStylesLines} 行, ${gasStylesKb} KB)`);
console.log(`   3. dist/gas/scripts.html     (${gasScriptsLines} 行, ${gasScriptsKb} KB)\n`);

console.log('─── B. 正式發布版 (極速瘦身，手機端首選)：');
console.log(`   1. dist/gas/index.min.html   (${gasIndexLines} 行, ${gasIndexMinKb} KB) ──► 引入 styles.min 與 scripts.min`);
console.log(`   2. dist/gas/styles.min.html  (${gasStylesMinLines} 行, ${gasStylesMinKb} KB，瘦身 ${Math.round((1 - gasStylesMinKb / gasStylesKb) * 100)}%)`);
console.log(`   3. dist/gas/scripts.min.html (${gasScriptsMinLines} 行, ${gasScriptsMinKb} KB，瘦身 ${Math.round((1 - gasScriptsMinKb / gasScriptsKb) * 100)}%)\n`);

console.log('📄 【本機單體備援/測試檔】：');
console.log(`   - index.html                 (${bundleLines} 行, 完整離線單體)\n`);

