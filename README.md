# campus-attendance
這裡是小排點名系統的「GitHub Pages 專屬無橫幅入口」，完整說明如下：

# 📋 小排點名網站 (Campus Attendance System)

> **工程師速覽**：無框架原生 SPA（輕量 RWD）+ Google Apps Script (GAS) 後端 + Google Sheets 雲端資料庫。核心具備 0ms 樂觀響應、防抖背景同步、雙態回滾防護與 100% 離線單元測試。

---

## ⚡ 架構關鍵心法 (Architecture & Invariants)

1. **0ms 樂觀響應 + 滑動防抖**：前端 DOM 點擊即時反饋；400ms 窗口內連續操作聚合為單一 RPC (`google.script.run`) 批次寫回。支援意圖保護（在途請求不覆蓋最新修改）與連點自我消除。
2. **反向行號推算 ($R'$) 與指數退避**：萬列點名大表以尾端行號逆推當週偏移，搭配指數退避 (50 ➔ 100 ➔ 200) 分區覆寫與殘留清除，免全表掃描。
3. **免橫幅外層包裝 (Anti-Banner)**：GAS Web App 於手機（特別是 LINE）直接開啟會出現 Google 頂部警告橫幅；專案透過 GitHub Pages ([`github_pages_wrapper.html`](github_pages_wrapper.html) iframe) 作為外層容器徹底消除橫幅。
4. **深模組設計 (Deep Modules)**：業務邏輯全數封裝在 Store/Repository 後方，UI 控制器僅監聽狀態，前後端邏輯徹底解耦。

---

## 🏗️ 核心模組與目錄對照 (Codebase Map)

| 模組 | 路徑 | 職責 |
| :--- | :--- | :--- |
| **AttendanceStore** | `src/js/attendance_store.js` | 點名出席狀態機（desiredState vs syncedState、R' 反向偏移、防抖批次佇列） |
| **MemberStore** | `src/js/member_store.js` | 人員管理狀態機（記憶體非破壞性合併、樂觀名單防跳動排序） |
| **CampusStore** | `src/js/campus_store.js` | 小排管理狀態機（深拷貝快照比對、無實質變更防護、拖曳排序） |
| **StatsAggregator** | `src/js/stats_aggregator.js` | 純領域資料運算（時間軸展開、**自動排除服事者/家長**、雙向次要排序打破） |
| **Core** | `src/js/core.js` | 全域狀態實例化、RPC Promise 封裝 (`callServer`)、CampusDomain 領域規則 |
| **UI Controllers** | `src/js/{campuses,attendance,stats,ui}.js` | DOM 渲染、Chart.js 圖表聯動與事件委派 |
| **SpreadsheetRepository** | `backup.gs` | 後端資料倉儲（5 欄點名架構、指數退避切片讀寫、跨表原子性更新） |
| **GoogleSheetAdapter** | `backup.gs` | `LockService` 併發鎖排隊與 Sheet 原生 I/O 適配器 |

> ⚠️ **維護鐵律**：請勿直接手動修改根目錄 `index.html` 或 `dist/`！前端模組全在 `src/`，修改後必須執行構建指令（`node build.js` 或執行 `run_tests.bat`）自動重新編譯打包至 `dist/gas/`，否則修改不會生效，且下次構建時會被覆蓋。

---

## 🛠️ 開發、構建與測試指令 (Workflow)

```bash
# 1. 本地極速構建 (< 30ms，純 Node.js 零外部依賴)
node build.js

# 2. 執行全套離線單元測試 (雙擊 run_tests.bat 或直接執行)
run_tests.bat
```
- **測試覆蓋**：7 大測試套件、**69 項單元測試（100% PASS）**，涵蓋狀態機、併發指數探測、資料庫初始化與報表計算。

---

## 🚀 部署與雙軌發布 (Deployment)

### 1. 初次安裝
1. Google Sheet 內點選 **擴充功能** → **Apps Script**。
2. **後端**：將 [`backup.gs`](backup.gs) 內容貼入 `Code.gs`。
3. **前端**：在 Apps Script 專案新增 5 個 HTML 檔案，貼入 [`dist/gas/`](dist/gas/) 對應產物：
   - `index.html`、`styles.html`、`styles.min.html`、`scripts.html`、`scripts.min.html`
4. **初始化**：在編輯器執行一次 `initializeSheet` 函式（自動建立工作表與標題列）。
5. **發布**：點擊 **部署** → **新增部署作業** → 網頁應用程式（存取權：所有人）。

### 2. 雙檔併行切換技巧 (一秒切換)
- **日常維護／除錯**：GAS 的 `index.html` 維持使用完整版（含 222 個函式 JSDoc 與原始行號，DevTools 報錯秒定位）。
- **正式發布上線**：直接複製 [`dist/gas/index.min.html`](dist/gas/index.min.html) 覆蓋貼入 GAS 的 `index.html`（自動引入 `.min` 檔，傳輸省近 80 KB，手機秒開）。

---

## 📊 資料庫欄位綱要 (Google Sheet Schema)

| 工作表 | 欄位定義 (1-indexed) | 關鍵規則 |
| :--- | :--- | :--- |
| **`校園列表`** | `A:校園ID`, `B:校園名稱`, `C:分類(高中/國中/社區排)`, `D:排序`, `E:是否封存(BOOL)`, `F:小排暫停週次(空格分隔YYYY-MM-DD)` | 封存保留歷史；暫停週統計可智慧扣除 |
| **`人員名單`** | `A:校園ID`, `B:累計出席次數`, `C:姓名`, `D:身分(弟兄/姊妹/男界朋友/女界朋友/服事者/家長)`, `E:學段`, `F:預設值(出席,禱告,出訪)`, `G:其他小排ID` | 同校姓名唯一；B 欄由系統自動維護近 8 週到會數 |
| **`點名紀錄`** | `A:校園ID`, `B:姓名`, `C:當時身分`, `D:週次(YYYY-MM-DD)`, `E:類型(出席/禱告/傳福音)` | 歷史身分凍結；向下相容舊版 4 欄格式 |

---

## 📁 檔案結構導覽

```text
├── src/                               # 前端模組源碼 (HTML / CSS / JS)
├── dist/gas/                          # GAS 雙軌發布產物 (index/styles/scripts 各含完整與 min 檔)
├── backup.gs                          # GAS 後端核心 (Repository + Adapter)
├── github_pages_wrapper.html          # 免頂部警告橫幅之外層轉發容器
├── build.js                           # 本地極速構建打包腳本
├── run_tests.bat                      # 構建 + 69 項離線單元測試腳本
└── test_*.js                          # 7 大離線測試套件
```

---

## 🔗 相關連結

- **GitHub 專案儲存庫**：[hsnu125739/campus-attendance](https://github.com/hsnu125739/campus-attendance)
- **GitHub Pages 免橫幅入口**：[hsnu125739.github.io/campus-attendance](https://hsnu125739.github.io/campus-attendance/)（消除 GAS 頂部警告橫幅）
- **授權條款**：[MIT License](LICENSE)
