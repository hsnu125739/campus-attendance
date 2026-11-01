/**
 * 小排點名網站 - Google Apps Script 後端 (SpreadsheetRepository 工作流深模組架構)
 * 
 * 核心架構特色：
 * 1. 【SpreadsheetRepository 深模組】：將試算表 2D 座標、欄位映射、鎖管理與舊版相容徹底封裝於單一介面背後。
 * 2. 【分層資料儲存適配器 (GoogleSheetAdapter)】：將試算表存取、範圍讀寫、欄位格式化與腳本鎖 (LockService) 封裝於專屬適配器，業務邏輯與底層 I/O 徹底解耦。
 * 3. 【5 欄點名紀錄架構】：[A: 校園ID, B: 姓名, C: 當時身分, D: 週次, E: 類型]（透明向下相容 4 欄舊資料）。
 * 4. 【指數退避分區覆寫探測】：以動態緩衝 (50 -> 100 -> 200...) 進行局部寫入與多餘尾部殘留清除。
 * 5. 【社區排/校園排隔離維護】：社區排主導跨校連結，校園排局域隔離；人員改名時原子聯動更新歷史點名表。
 * 6. 【多學期點名統計報表產出引擎】：多行週次表頭、跨月週次無縫捕獲、二維矩陣批次著色。
 */

/**
 * 試算表 ID 設定（若為綁定試算表之指令碼則自動抓取當前試算表）
 */
const SHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

/**
 * 工作表（分頁）名稱設定
 */
const SHEET_NAMES = {
  CAMPUSES:   '校園列表',
  MEMBERS:    '人員名單',
  ATTENDANCE: '點名紀錄'
};

/**
 * 校園與分類領域規則物件
 */
const CampusDomain = {
  COMMUNITY_CATEGORY: '社區排',
  SCHOOL_CATEGORIES: ['國中', '高中'],

  /**
   * 解析校園物件或分類字串之分類名稱
   * @param {Object|string} campusOrCat 校園物件或分類字串
   * @returns {string} 分類名稱（如 '國中', '高中', '社區排'）
   */
  getCat(campusOrCat) {
    if (!campusOrCat) return '';
    return (typeof campusOrCat === 'string') ? campusOrCat : (campusOrCat.category || '');
  },

  /**
   * 判斷是否為學生校園排（國中或高中）
   * @param {Object|string} campusOrCat 校園物件或分類字串
   * @returns {boolean}
   */
  isSchool(campusOrCat) {
    return this.SCHOOL_CATEGORIES.includes(this.getCat(campusOrCat));
  },

  /**
   * 判斷是否為社區排
   * @param {Object|string} campusOrCat 校園物件或分類字串
   * @returns {boolean}
   */
  isCommunity(campusOrCat) {
    return this.getCat(campusOrCat) === this.COMMUNITY_CATEGORY;
  }
};

// ==========================================
// ===== 模組一：試算表核心工具與資料正規化 =====
// ==========================================

/**
 * 取得試算表實例（支援綁定試算表與獨立 Web App）
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet|null}
 */
function getSpreadsheet() {
  if (typeof SpreadsheetApp === 'undefined') return null;
  if (SHEET_ID && SHEET_ID !== 'YOUR_SPREADSHEET_ID_HERE') {
    try {
      return SpreadsheetApp.openById(SHEET_ID);
    } catch (e) {}
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * 取得特定名稱的工作表
 * @param {string} name 
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function getSheetByName(name) {
  const ss = getSpreadsheet();
  return ss ? ss.getSheetByName(name) : null;
}

/**
 * 標準化日期或週次字串為 YYYY-MM-DD
 * 完整支援 Date 物件、YYYY/M/D、YYYY-M-D、YYYY.M.D 及帶時間之字串
 * @param {Date|string} val 
 * @returns {string}
 */
function normalizeWeekStr(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(val).trim();
  const match = str.match(/^(\d{4})[/\-\.](\d{1,2})[/\-\.](\d{1,2})/);
  if (match) {
    const y = match[1];
    const m = match[2].padStart(2, '0');
    const d = match[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return str;
}

/**
 * 解析校園 F 欄「小排暫停週次」儲存格值
 * @param {any} cellVal 儲存格原始值 (Date 或 string)
 * @returns {string[]} 有序之標準週次陣列 ['YYYY-MM-DD', ...]
 */
function parseSuspendedWeeks(cellVal) {
  if (!cellVal) return [];
  if (cellVal instanceof Date) {
    const w = normalizeWeekStr(cellVal);
    return w ? [w] : [];
  }
  const str = String(cellVal).trim();
  if (!str) return [];

  const tokens = str.split(/\s+/).filter(Boolean);
  const result = [];
  tokens.forEach(tok => {
    const w = normalizeWeekStr(tok);
    if (w && !result.includes(w)) result.push(w);
  });
  return result.sort();
}

/**
 * 檢查是否為有效之 YYYY-MM-DD 週次格式
 * @param {any} val
 * @returns {boolean}
 */
function isValidWeekStr(val) {
  const norm = normalizeWeekStr(val);
  return /^\d{4}-\d{2}-\d{2}$/.test(norm);
}

/**
 * 解析單筆點名紀錄列（標準 5 欄：[校園ID, 姓名, 當時身分, 週次, 類型]）
 * @param {Array} row 資料列
 * @param {Object} [roleLookup] 身分對照表 (campusId|name -> role)
 * @returns {{ campusId: string, name: string, role: string, week: string, type: string } | null}
 */
function parseAttendanceRow(row, roleLookup = {}) {
  if (!row || row.length < 5) return null;
  const campusId = String(row[0] || '').trim();
  const name     = String(row[1] || '').trim();
  if (!campusId || !name) return null;

  const role = String(row[2] || '').trim() || roleLookup[campusId + '|' + name] || '';
  const week = normalizeWeekStr(row[3]);
  const type = String(row[4] || '').trim() || '出席';

  if (!week || !isValidWeekStr(week)) return null;
  return { campusId: campusId, name: name, role: role, week: week, type: type };
}

/**
 * 批次覆寫工作表指定區間（原位覆寫並自動清除尾部殘留列，標題列絕對不受影響）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 目標工作表
 * @param {Array<Array>} dataRows 二維純資料陣列
 * @param {number} colCount 欄位數
 * @param {number} [startRow=2] 開始寫入的列號（預設為 2，保護第 1 列標題）
 */
function setSheetRows(sheet, dataRows, colCount, startRow = 2) {
  if (!sheet) return;
  const oldLastRow = sheet.getLastRow();
  const maxCols = Math.max(colCount, sheet.getLastColumn() || colCount);

  // 情況 A：傳入空陣列（清空 startRow 及其以下的所有資料列）
  if (!dataRows || dataRows.length === 0) {
    if (oldLastRow >= startRow) {
      sheet.getRange(startRow, 1, oldLastRow - startRow + 1, maxCols).clearContent();
    }
    return;
  }

  // 情況 B：原位覆寫資料列
  sheet.getRange(startRow, 1, dataRows.length, colCount).setValues(dataRows);

  // 計算寫入後的最新末端列號
  const newLastRow = startRow + dataRows.length - 1;

  // 若舊資料列數超出新資料範圍，精確清除尾部殘留列
  if (oldLastRow > newLastRow) {
    sheet.getRange(newLastRow + 1, 1, oldLastRow - newLastRow, maxCols).clearContent();
  }
}

// ==========================================
// ===== 模組二：儲存接縫與資料適配器 (GoogleSheetAdapter) =====
// ==========================================

/**
 * 生產環境適配器：Google 試算表與 LockService (GoogleSheetAdapter)
 */
class GoogleSheetAdapter {
  /**
   * 封裝 LockService 執行原子性操作
   * @param {number} timeoutMs 鎖定超時毫秒數
   * @param {Function} action 欲執行的回調函式
   * @returns {*} action 執行結果，若超時則回傳友善錯誤物件
   */
  withLock(timeoutMs, action) {
    if (typeof LockService === 'undefined') {
      return action();
    }
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs)) {
      return { success: false, error: '系統目前繁忙（其他使用者正在同步資料），請稍候片刻再試' };
    }
    try {
      return action();
    } finally {
      try {
        lock.releaseLock();
      } catch (e) {}
    }
  }

  /**
   * 批次讀取工作表列資料
   * @param {string} sheetName 工作表名稱
   * @param {Object} [options]
   * @param {number} [options.startRow=2] 起始列號
   * @param {number} [options.numRows] 讀取列數
   * @param {number} [options.numCols] 讀取欄數
   * @returns {Array<Array>}
   */
  readRows(sheetName, options) {
    const sheet = getSheetByName(sheetName);
    if (!sheet) return [];
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    const startRow = (options && options.startRow) || 2;
    if (startRow > lastRow) return [];
    const numRows = (options && options.numRows) ? Math.min(options.numRows, lastRow - startRow + 1) : (lastRow - startRow + 1);
    if (numRows <= 0) return [];
    const cols = (options && options.numCols) || sheet.getLastColumn() || 1;
    return sheet.getRange(startRow, 1, numRows, cols).getValues();
  }

  /**
   * 批次寫入列資料至工作表
   * @param {string} sheetName 工作表名稱
   * @param {Array<Array>} rows 欲寫入的二維矩陣
   * @param {number} [startRow=2] 起始列號
   * @param {number} [numCols] 寫入欄數
   */
  writeRows(sheetName, rows, startRow = 2, numCols) {
    const sheet = getSheetByName(sheetName);
    if (!sheet) return;
    const cols = numCols || (rows && rows.length > 0 ? rows[0].length : (sheet.getLastColumn() || 1));
    setSheetRows(sheet, rows, cols, startRow);
  }

  /**
   * 單欄批次寫入資料
   * @param {string} sheetName 工作表名稱
   * @param {number} colIndex 欄位索引 (1-indexed)
   * @param {Array<Array>} values2D 二維單欄值陣列 ([[v1], [v2], ...])
   * @param {number} [startRow=2] 起始列號
   */
  writeColumn(sheetName, colIndex, values2D, startRow = 2) {
    const sheet = getSheetByName(sheetName);
    if (!sheet || !values2D || values2D.length === 0) return;
    sheet.getRange(startRow, colIndex, values2D.length, 1).setValues(values2D);
  }

  /**
   * 清除指定範圍列內容
   * @param {string} sheetName 工作表名稱
   * @param {number} startRow 起始列號
   * @param {number} numRows 清除列數
   * @param {number} [numCols] 清除欄數
   */
  clearRows(sheetName, startRow, numRows, numCols) {
    const sheet = getSheetByName(sheetName);
    if (!sheet || numRows <= 0) return;
    const cols = numCols || sheet.getLastColumn() || 1;
    sheet.getRange(startRow, 1, numRows, cols).clearContent();
  }

  /**
   * 取得工作表最後一列列號
   * @param {string} sheetName 工作表名稱
   * @returns {number}
   */
  getLastRow(sheetName) {
    const sheet = getSheetByName(sheetName);
    return sheet ? sheet.getLastRow() : 0;
  }

  /**
   * 設定指定欄位之數字格式
   * @param {string} sheetName 工作表名稱
   * @param {number} colIndex 欄位索引 (1-indexed)
   * @param {string} format 格式字串（例如 '@' 代表純文字）
   * @param {number} [startRow=2] 起始列號
   * @param {number} [numRows] 設定列數
   */
  setColumnNumberFormat(sheetName, colIndex, format, startRow = 2, numRows) {
    const sheet = getSheetByName(sheetName);
    if (!sheet) return;
    const rows = numRows || Math.max(1, sheet.getLastRow() - startRow + 1);
    sheet.getRange(startRow, colIndex, rows, 1).setNumberFormat(format);
  }

  /**
   * 確保結構工作表皆已存在，若不存在則自動新建並寫入標題
   * @param {Object.<string, Array<string>>} schemas 表格架構字典
   */
  ensureSheets(schemas) {
    const ss = getSpreadsheet();
    if (!ss) throw new Error('無法連接試算表');
    for (const [sheetName, headers] of Object.entries(schemas)) {
      let sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        sheet.appendRow(headers);
        sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      }
    }
  }
}

// ==========================================
// ===== 模組三：SpreadsheetRepository 深模組 =====
// ==========================================

/**
 * 試算表資料倉儲深模組 (SpreadsheetRepository Deep Module)
 * 完整封裝座標索引、鎖生命週期、指數退避、舊版格式相容、改名連動與社群關聯規則。
 */
class SpreadsheetRepository {
  /**
   * @param {GoogleSheetAdapter} [adapter]
   */
  constructor(adapter) {
    this.adapter = adapter || new GoogleSheetAdapter();
  }

  /**
   * 1. 試算表結構初始化
   */
  initializeSheet() {
    try {
      const schemas = {
        [SHEET_NAMES.CAMPUSES]:   ['校園ID', '校園名稱', '分類', '排序', '是否封存', '小排暫停週次'],
        [SHEET_NAMES.MEMBERS]:    ['校園ID', '累計出席次數', '姓名', '身分', '學段', '預設值', '其他小排ID'],
        [SHEET_NAMES.ATTENDANCE]: ['校園ID', '姓名', '當時身分', '週次', '類型']
      };
      this.adapter.ensureSheets(schemas);
      return { success: true, message: '試算表初始化完成' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 2. 首頁完整快照載入 (Server-side Preload)
   * 包含校園排序、成員次數排序、學段推斷與安全週次切片
   */
  loadInitialSnapshot(options) {
    try {
      // (1) 校園列表
      const campData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const campuses = [];
      const archivedCampuses = [];

      campData.forEach(row => {
        const id = String(row[0] || '').trim();
        const name = String(row[1] || '').trim();
        const category = String(row[2] || '').trim();
        const sort = Number(row[3]) || 0;
        const isArchived = row[4] === true || String(row[4]).toUpperCase() === 'TRUE';
        const suspendedWeeks = parseSuspendedWeeks(row[5]);

        if (id && name) {
          const item = { id, name, category, sort, isArchived, suspendedWeeks };
          if (isArchived) {
            archivedCampuses.push(item);
          } else {
            campuses.push(item);
          }
        }
      });

      campuses.sort((a, b) => {
        if (a.category === '高中' && b.category !== '高中') return -1;
        if (a.category !== '高中' && b.category === '高中') return 1;
        return a.sort - b.sort;
      });
      archivedCampuses.sort((a, b) => a.sort - b.sort);

      // (2) 人員名單
      const campusCatMap = {};
      campuses.forEach(c => { campusCatMap[c.id] = c.category; });
      archivedCampuses.forEach(c => { campusCatMap[c.id] = c.category; });

      const memberData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const membersByCampus = {};
      const memberRoleLookup = {};

      memberData.forEach(row => {
        const campusId = String(row[0] || '').trim();
        const count = Number(row[1]) || 0;
        const name = String(row[2] || '').trim();
        if (campusId && name) {
          if (!membersByCampus[campusId]) membersByCampus[campusId] = [];
          const role = String(row[3] || '').trim();
          const rawStage = String(row[4] || '').trim();
          const defaultsStr = String(row[5] || '').trim();
          const defaults = defaultsStr ? defaultsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
          const otherGroupId = String(row[6] || '').trim();
          const cCat = campusCatMap[campusId] || '';
          const defaultStage = (cCat === '國中' || cCat === '高中') ? cCat : '其他';
          const stage = (!rawStage || (rawStage === '其他' && (cCat === '國中' || cCat === '高中'))) ? defaultStage : rawStage;

          membersByCampus[campusId].push({
            name, count, role, defaults, otherGroupId, stage
          });
          memberRoleLookup[campusId + '|' + name] = role;
        }
      });

      for (const cid in membersByCampus) {
        membersByCampus[cid].sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return a.name.localeCompare(b.name);
        });
      }

      // (3) 點名紀錄安全視窗 (固定倒數 2000 列，防範殘缺週並計算次早週)
      const attendanceByCampus = {};
      let minLoadedWeek = '0000-00-00';
      const lastRow = this.adapter.getLastRow(SHEET_NAMES.ATTENDANCE);

      if (lastRow > 1) {
        const chunkSize = (options && options.attendanceChunkSize) || 2000;
        const startRow = Math.max(2, lastRow - chunkSize + 1);
        const numRows = lastRow - startRow + 1;
        const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow, numRows, numCols: 5 });

        let startIdx = 0;
        if (startRow > 2 && attData.length > 0) {
          const firstRec = parseAttendanceRow(attData[0]);
          const firstWeek = firstRec ? normalizeWeekStr(firstRec.week) : '';
          while (startIdx < attData.length) {
            const rec = parseAttendanceRow(attData[startIdx]);
            if (rec && normalizeWeekStr(rec.week) === firstWeek) {
              startIdx++;
            } else {
              break;
            }
          }
          if (startIdx < attData.length) {
            const nextRec = parseAttendanceRow(attData[startIdx]);
            if (nextRec) minLoadedWeek = normalizeWeekStr(nextRec.week);
          }
        }

        for (let i = startIdx; i < attData.length; i++) {
          const record = parseAttendanceRow(attData[i], memberRoleLookup);
          if (record) {
            if (!attendanceByCampus[record.campusId]) attendanceByCampus[record.campusId] = [];
            attendanceByCampus[record.campusId].push({
              name: record.name,
              week: record.week,
              type: record.type,
              role: record.role
            });
          }
        }
      }

      return {
        success: true,
        data: {
          campuses,
          archivedCampuses,
          membersByCampus,
          attendanceByCampus,
          minLoadedWeek
        }
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 3. 查詢指定區間歷史點名紀錄
   */
  queryAttendanceHistory(campusId, startWeek, endWeek) {
    try {
      campusId = (campusId || '').trim();
      startWeek = normalizeWeekStr(startWeek);
      endWeek = normalizeWeekStr(endWeek);

      // 取得身分字典
      const memberRoleLookup = {};
      const mData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      mData.forEach(row => {
        const cid = String(row[0] || '').trim();
        const name = String(row[2] || '').trim();
        if (cid && name) memberRoleLookup[cid + '|' + name] = String(row[3] || '').trim();
      });

      const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numCols: 5 });
      const attendanceByCampus = {};
      let hasMore = false;

      for (let i = 0; i < attData.length; i++) {
        const record = parseAttendanceRow(attData[i], memberRoleLookup);
        if (!record) continue;

        if (startWeek && record.week < startWeek) {
          hasMore = true;
          continue;
        }
        if (endWeek && record.week > endWeek) continue;
        if (campusId && record.campusId !== campusId) continue;

        if (!attendanceByCampus[record.campusId]) attendanceByCampus[record.campusId] = [];
        attendanceByCampus[record.campusId].push({
          name: record.name,
          week: record.week,
          type: record.type,
          role: record.role
        });
      }

      return {
        success: true,
        data: {
          attendanceByCampus,
          hasMore
        }
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 4. 取得特定校園最新人員名單
   */
  getCampusMembersFresh(campusId) {
    try {
      campusId = (campusId || '').trim();
      if (!campusId) return { success: false, error: '校園ID不能為空' };

      const cData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      let campusCategory = '';
      for (let i = 0; i < cData.length; i++) {
        if (String(cData[i][0]).trim() === campusId) {
          campusCategory = String(cData[i][2] || '').trim();
          break;
        }
      }
      const defaultStage = (campusCategory === '國中' || campusCategory === '高中') ? campusCategory : '其他';

      const data = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const members = [];
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === campusId) {
          const name = String(data[i][2]).trim();
          if (name) {
            const count = Number(data[i][1]) || 0;
            const role = String(data[i][3] || '').trim();
            const rawStage = String(data[i][4] || '').trim();
            const defaultsStr = String(data[i][5] || '').trim();
            const defaults = defaultsStr ? defaultsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
            const otherGroupId = String(data[i][6] || '').trim();
            const stage = (!rawStage || (rawStage === '其他' && (campusCategory === '國中' || campusCategory === '高中'))) ? defaultStage : rawStage;
            members.push({ name, count, role, defaults, otherGroupId, stage });
          }
        }
      }
      members.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
      return { success: true, members };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 5. 批次儲存校園清單
   */
  syncCampuses(campusList) {
    return this.adapter.withLock(10000, () => {
      if (!Array.isArray(campusList)) return { success: false, error: '校園列表格式錯誤' };

      const idPattern = /^(CAMP|COMM)_\d+$/;
      for (const c of campusList) {
        if (!idPattern.test(String(c.id).trim())) return { success: false, error: '無效的校園ID: ' + c.id };
        if (!String(c.name).trim()) return { success: false, error: '校園名稱不能為空' };
      }

      // 讀取現有資料以保留暫停週次備援
      const existingData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const existingSuspendedMap = {};
      for (let i = 0; i < existingData.length; i++) {
        const cid = String(existingData[i][0]).trim();
        existingSuspendedMap[cid] = parseSuspendedWeeks(existingData[i][5]).join(' ');
      }

      const rows = [];
      campusList.forEach(c => {
        let suspendedStr = '';
        if (Array.isArray(c.suspendedWeeks)) {
          suspendedStr = c.suspendedWeeks.join(' ');
        } else if (typeof c.suspendedWeeks === 'string') {
          suspendedStr = parseSuspendedWeeks(c.suspendedWeeks).join(' ');
        } else if (existingSuspendedMap[c.id]) {
          suspendedStr = existingSuspendedMap[c.id];
        }

        rows.push([
          String(c.id).trim(),
          String(c.name).trim(),
          String(c.category).trim(),
          Number(c.sort) || 0,
          c.isArchived === true,
          suspendedStr
        ]);
      });

      this.adapter.writeRows(SHEET_NAMES.CAMPUSES, rows, 2, 6);
      if (rows.length > 0) {
        this.adapter.setColumnNumberFormat(SHEET_NAMES.CAMPUSES, 6, '@', 2, rows.length);
      }
      return { success: true };
    });
  }

  /**
   * 6. 設定校園封存狀態
   */
  setCampusArchivedStatus(campusId, isArchived) {
    return this.adapter.withLock(10000, () => {
      campusId = (campusId || '').trim();
      if (!campusId) return { success: false, error: '校園ID不能為空' };

      const data = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === campusId) {
          data[i][4] = isArchived;
          this.adapter.writeRows(SHEET_NAMES.CAMPUSES, data, 2, 6);
          return { success: true };
        }
      }
      return { success: false, error: '找不到該校園' };
    });
  }

  /**
   * 7. 切換小排暫停週次
   */
  toggleCampusSuspension(campusId, weekStr, isSuspended) {
    return this.adapter.withLock(10000, () => {
      campusId = (campusId || '').trim();
      weekStr = normalizeWeekStr(weekStr);
      if (!campusId || !weekStr) return { success: false, error: '校園ID或週次不能為空' };

      const data = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      let targetRowIdx = -1;
      let currentSuspendedWeeks = [];

      for (let i = 0; i < data.length; i++) {
        if (String(data[i][0]).trim() === campusId) {
          targetRowIdx = i;
          currentSuspendedWeeks = parseSuspendedWeeks(data[i][5]);
          break;
        }
      }

      if (targetRowIdx === -1) return { success: false, error: '找不到該校園' };

      const weekSet = new Set(currentSuspendedWeeks);
      if (isSuspended) {
        weekSet.add(weekStr);
      } else {
        weekSet.delete(weekStr);
      }

      const updatedWeeks = Array.from(weekSet).sort();
      data[targetRowIdx][5] = updatedWeeks.join(' ');

      this.adapter.writeRows(SHEET_NAMES.CAMPUSES, data, 2, 6);
      this.adapter.setColumnNumberFormat(SHEET_NAMES.CAMPUSES, 6, '@', targetRowIdx + 2, 1);

      return { success: true, suspendedWeeks: updatedWeeks };
    });
  }

  /**
   * 8. 批次人員名單 Diff 儲存（社區排雙向關聯 + 校園排隔離 + 點名表改名原子連動）
   */
  syncMembers(campusId, diffPayload) {
    return this.adapter.withLock(15000, () => {
      campusId = (campusId || '').trim();
      if (!campusId) return { success: false, error: '校園ID不能為空' };

      const changes = (diffPayload && Array.isArray(diffPayload.changes))
        ? diffPayload.changes
        : [];

      if (changes.length === 0) {
        return { success: true, count: 0 };
      }

      const cData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const campusCatMap = {};
      for (let i = 0; i < cData.length; i++) {
        const cid = String(cData[i][0]).trim();
        const cat = String(cData[i][2] || '').trim();
        if (cid) campusCatMap[cid] = cat;
      }
      const campusCategory = campusCatMap[campusId] || '';
      const isCommunityGroup = CampusDomain.isCommunity(campusCategory);
      const defaultStage = CampusDomain.isSchool(campusCategory) ? CampusDomain.getCat(campusCategory) : '其他';

      const allData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const campusRows = [];
      const otherRows = [];
      const campusNameIndex = new Map();

      for (let i = 0; i < allData.length; i++) {
        const cid = String(allData[i][0] || '').trim();
        const count = Number(allData[i][1]) || 0;
        const name = String(allData[i][2] || '').trim();
        if (!cid || !name) continue;

        const role = String(allData[i][3] || '').trim();
        const rowCat = campusCatMap[cid] || '';
        const rowDefaultStage = (rowCat === '國中' || rowCat === '高中') ? rowCat : '其他';
        const rawStage = String(allData[i][4] || '').trim();
        const stage = (!rawStage || (rawStage === '其他' && (rowCat === '國中' || rowCat === '高中'))) ? rowDefaultStage : rawStage;
        const defaults = String(allData[i][5] || '').trim();
        const otherGroupId = String(allData[i][6] || '').trim();

        const row = [cid, count, name, role, stage, defaults, otherGroupId];
        if (cid === campusId) {
          campusNameIndex.set(name, campusRows.length);
          campusRows.push(row);
        } else {
          otherRows.push(row);
        }
      }

      const nameChanges = [];
      const affectedMembers = [];
      const warnings = [];

      /**
       * 正規化與提取人員 Diff 變更欄位
       * @param {Object} change 前端傳入之成員變更物件
       * @returns {{ type: string, name: string, oldName: string, role: string, defaults: string, stage: string, otherGroupId: string }}
       */
      function parseChangeFields(change) {
        return {
          type: change.type,
          name: String(change.name || '').trim(),
          oldName: String(change.oldName || change.name || '').trim(),
          role: String(change.role || '').trim(),
          defaults: Array.isArray(change.defaults) ? change.defaults.join(',') : String(change.defaults || '').trim(),
          stage: String(change.stage || defaultStage).trim(),
          otherGroupId: String(change.otherGroupId || '').trim()
        };
      }

      if (isCommunityGroup) {
        // 社區排主導關聯維護
        const otherRowIndex = new Map();
        for (let r = 0; r < otherRows.length; r++) {
          otherRowIndex.set(otherRows[r][0] + '|' + otherRows[r][2], r);
        }

        /**
         * 更新學生所屬社區排雙向關聯欄位 (otherGroupId)
         * @param {string} targetCampusId 學生所在的校園 ID
         * @param {string} targetMemberName 學生姓名
         * @param {string} newCommId 綁定之社區排 ID（若解除則為空字串）
         */
        function updateCampusMemberLink(targetCampusId, targetMemberName, newCommId) {
          const key = targetCampusId + '|' + targetMemberName;
          const r = otherRowIndex.get(key);
          if (r !== undefined) {
            otherRows[r][6] = newCommId;
            affectedMembers.push({
              campusId: targetCampusId,
              name: targetMemberName,
              otherGroupId: newCommId
            });
          }
        }

        changes.forEach(change => {
          const f = parseChangeFields(change);
          if (!f.name) {
            warnings.push('變更項目中姓名為空，已略過此項目');
            return;
          }

          if (f.type === 'add') {
            if (campusNameIndex.has(f.name)) {
              warnings.push(`成員「${f.name}」已存在於此小排，略過重複新增`);
              return;
            }
            campusNameIndex.set(f.name, campusRows.length);
            campusRows.push([campusId, 0, f.name, f.role, f.stage, f.defaults, f.otherGroupId]);
            if (f.otherGroupId) {
              updateCampusMemberLink(f.otherGroupId, f.name, campusId);
            }
          } else if (f.type === 'delete') {
            const idx = campusNameIndex.get(f.name);
            if (idx !== undefined) {
              const prevOtherGroupId = campusRows[idx] ? campusRows[idx][6] : '';
              if (prevOtherGroupId) {
                updateCampusMemberLink(prevOtherGroupId, f.name, '');
              }
              campusRows[idx] = null;
              campusNameIndex.delete(f.name);
            } else {
              warnings.push(`成員「${f.name}」已不存在（可能已被其他使用者先一步刪除）`);
            }
          } else if (f.type === 'modify') {
            const idx = campusNameIndex.get(f.oldName);
            if (idx === undefined) {
              warnings.push(`成員「${f.oldName}」已不存在（可能已被其他使用者刪除），已略過其變更`);
              return;
            }
            if (f.oldName !== f.name && campusNameIndex.has(f.name)) {
              warnings.push(`成員「${f.name}」已存在於此小排，無法將「${f.oldName}」改為相同姓名`);
              return;
            }

            const prevCount = campusRows[idx][1];
            const prevOtherGroupId = campusRows[idx][6];

            if (prevOtherGroupId && (prevOtherGroupId !== f.otherGroupId || f.oldName !== f.name)) {
              updateCampusMemberLink(prevOtherGroupId, f.oldName, '');
            }
            if (f.otherGroupId) {
              updateCampusMemberLink(f.otherGroupId, f.name, campusId);
            }

            campusRows[idx] = [campusId, prevCount, f.name, f.role, f.stage, f.defaults, f.otherGroupId];

            if (f.oldName !== f.name) {
              campusNameIndex.delete(f.oldName);
              campusNameIndex.set(f.name, idx);
              nameChanges.push({ oldName: f.oldName, newName: f.name });
            }
          }
        });
      } else {
        // 校園排：最多只能動自己這列
        const waitingCommunityLinks = {};
        for (let r = 0; r < otherRows.length; r++) {
          if (otherRows[r][6] === campusId) {
            waitingCommunityLinks[otherRows[r][2]] = otherRows[r][0];
          }
        }

        changes.forEach(change => {
          const f = parseChangeFields(change);
          if (!f.name) {
            warnings.push('變更項目中姓名為空，已略過此項目');
            return;
          }

          if (f.type === 'add') {
            if (campusNameIndex.has(f.name)) {
              warnings.push(`成員「${f.name}」已存在於此小排，略過重複新增`);
              return;
            }
            const otherGroupId = waitingCommunityLinks[f.name] || '';
            campusNameIndex.set(f.name, campusRows.length);
            campusRows.push([campusId, 0, f.name, f.role, f.stage, f.defaults, otherGroupId]);
          } else if (f.type === 'delete') {
            const idx = campusNameIndex.get(f.name);
            if (idx !== undefined) {
              campusRows[idx] = null;
              campusNameIndex.delete(f.name);
            } else {
              warnings.push(`成員「${f.name}」已不存在（可能已被其他使用者先一步刪除）`);
            }
          } else if (f.type === 'modify') {
            const idx = campusNameIndex.get(f.oldName);
            if (idx === undefined) {
              warnings.push(`成員「${f.oldName}」已不存在（可能已被其他使用者刪除），已略過其變更`);
              return;
            }
            if (f.oldName !== f.name && campusNameIndex.has(f.name)) {
              warnings.push(`成員「${f.name}」已存在於此小排，無法將「${f.oldName}」改為相同姓名`);
              return;
            }

            const oldRow = campusRows[idx];
            const prevCount = oldRow[1];
            const prevStage = oldRow[4];
            let otherGroupId = oldRow[6];

            const isRenamed = (f.oldName !== f.name);
            const isStageChanged = (prevStage && prevStage !== f.stage);

            if (isRenamed || isStageChanged) {
              otherGroupId = '';
            }

            campusRows[idx] = [campusId, prevCount, f.name, f.role, f.stage, f.defaults, otherGroupId];

            if (isRenamed) {
              campusNameIndex.delete(f.oldName);
              campusNameIndex.set(f.name, idx);
              nameChanges.push({ oldName: f.oldName, newName: f.name });
            }
          }
        });
      }

      const activeCampusRows = campusRows.filter(r => r !== null);
      const finalData = [...otherRows, ...activeCampusRows];
      this.adapter.writeRows(SHEET_NAMES.MEMBERS, finalData, 2, 7);

      // 若有改名，原子連動更新點名紀錄中的舊姓名
      if (nameChanges.length > 0) {
        const nameChangeMap = new Map();
        nameChanges.forEach(c => nameChangeMap.set(c.oldName, c.newName));

        // 解析傳遞改名鏈 (如 A -> B, B -> C 則 A 應直接對應至 C；若 A -> B -> A 則無需改名)
        for (const [oldName, newName] of nameChangeMap.entries()) {
          let current = newName;
          const visited = new Set([oldName]);
          while (nameChangeMap.has(current) && !visited.has(current)) {
            visited.add(current);
            current = nameChangeMap.get(current);
          }
          if (current === oldName) {
            nameChangeMap.delete(oldName);
          } else {
            nameChangeMap.set(oldName, current);
          }
        }

        if (nameChangeMap.size > 0) {
          const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numCols: 5 });
          let changed = false;
          for (let i = 0; i < attData.length; i++) {
            if (String(attData[i][0]).trim() === campusId) {
              const rowName = String(attData[i][1]).trim();
              const newName = nameChangeMap.get(rowName);
              if (newName) {
                attData[i][1] = newName;
                changed = true;
              }
            }
          }
          if (changed) {
            this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, attData, 2, 5);
          }
        }
      }

      const returnedMembers = activeCampusRows.map(r => {
        const defStr = String(r[5] || '').trim();
        return {
          name: String(r[2]).trim(),
          count: Number(r[1]) || 0,
          role: String(r[3] || '').trim(),
          stage: String(r[4] || '').trim() || defaultStage,
          defaults: defStr ? defStr.split(',').map(s => s.trim()).filter(Boolean) : [],
          otherGroupId: String(r[6] || '').trim()
        };
      });
      returnedMembers.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });

      return {
        success: true,
        count: changes.length,
        members: returnedMembers,
        affectedMembers,
        warnings
      };
    });
  }

  /**
   * 內部輔助：以指數退避探測讀取涵蓋目標週次的點名資料切片
   * @private
   * @param {string} weekStr 目標週次 YYYY-MM-DD
   * @param {number|string} rPrime 前端預估之末端偏移量
   * @param {number} lastRow 工作表末端列號
   * @returns {{ sliceData: Array<Array>, startFetchRow: number }}
   */
  _probeAttendanceSlice(weekStr, rPrime, lastRow) {
    let buffer = 50;
    let startFetchRow = 2;
    let sliceData = [];
    let numRowsToRead = 0;

    const rOffset = Number(rPrime);
    const baseRow = rOffset > 0 ? Math.max(2, lastRow - rOffset) : lastRow;

    while (true) {
      startFetchRow = Math.max(2, baseRow - buffer);
      numRowsToRead = lastRow - startFetchRow + 1;
      if (numRowsToRead <= 0) { startFetchRow = 2; numRowsToRead = lastRow - 1; }
      sliceData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: startFetchRow, numRows: numRowsToRead, numCols: 5 });

      if (startFetchRow <= 2) break;

      const firstRowRec = parseAttendanceRow(sliceData[0]);
      const firstWeek = firstRowRec ? normalizeWeekStr(firstRowRec.week) : '';

      if (firstWeek && firstWeek < weekStr) break;

      buffer *= 2;
    }

    return { sliceData, startFetchRow };
  }

  /**
   * 9. 批次點名同步（指數退避探測 + 原位覆寫 + 尾部殘留清除）
   */
  syncAttendance(campusId, weekStr, marks, unmarks, rPrime) {
    return this.adapter.withLock(15000, () => {
      campusId = (campusId || '').trim();
      weekStr  = normalizeWeekStr(weekStr);
      marks    = Array.isArray(marks) ? marks : [];
      unmarks  = Array.isArray(unmarks) ? unmarks : [];

      if (!campusId || !weekStr) {
        return { success: false, error: '校園ID或週次不能為空' };
      }

      if (marks.length === 0 && unmarks.length === 0) {
        return { success: true, message: '無變更項目' };
      }

      const lastRow = this.adapter.getLastRow(SHEET_NAMES.ATTENDANCE);

      if (lastRow <= 1) {
        const newRows = [];
        for (const m of marks) {
          const name = String(m.name || '').trim();
          const type = String(m.type || '出席').trim();
          const role = String(m.role || '').trim();
          if (name) newRows.push([campusId, name, role, weekStr, type]);
        }
        this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, newRows, 2, 5);
        return { success: true, addedCount: marks.length, removedCount: 0, startFetchRow: 2, newRowCount: newRows.length };
      }

      // 指數退避探測 (Exponential Probing)
      const { sliceData, startFetchRow } = this._probeAttendanceSlice(weekStr, rPrime, lastRow);

      // 記憶體局部更新
      const unmarkSet = new Set(
        unmarks.map(u => String(u.name || '').trim() + '|' + String(u.type || '出席').trim())
      );

      const remainingRows = [];
      const existingSet = new Set();
      let removedCount = 0;

      for (let i = 0; i < sliceData.length; i++) {
        const row = sliceData[i];
        const rec = parseAttendanceRow(row);
        if (!rec) continue;

        const normW = normalizeWeekStr(rec.week);

        if (rec.campusId === campusId && normW === weekStr && unmarkSet.has(rec.name + '|' + rec.type)) {
          removedCount++;
          continue;
        }

        remainingRows.push([rec.campusId, rec.name, rec.role, normW, rec.type]);
        existingSet.add(`${rec.campusId}|${rec.name}|${normW}|${rec.type}`);
      }

      let addedCount = 0;
      for (const m of marks) {
        const name = String(m.name || '').trim();
        const type = String(m.type || '出席').trim();
        const role = String(m.role || '').trim();
        if (!name) continue;

        const key = `${campusId}|${name}|${weekStr}|${type}`;
        if (!existingSet.has(key)) {
          remainingRows.push([campusId, name, role, weekStr, type]);
          existingSet.add(key);
          addedCount++;
        }
      }

      remainingRows.sort((a, b) => {
        const cmpW = a[3].localeCompare(b[3]);
        if (cmpW !== 0) return cmpW;
        const cmpC = a[0].localeCompare(b[0]);
        if (cmpC !== 0) return cmpC;
        return a[1].localeCompare(b[1]);
      });

      this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, remainingRows, startFetchRow, 5);

      return {
        success: true,
        addedCount,
        removedCount,
        startFetchRow,
        newRowCount: remainingRows.length
      };
    });
  }

  /**
   * 10. 套用預設出席紀錄至特定週次
   */
  applyDefaultAttendance(campusId, weekStr, records, rPrime) {
    return this.adapter.withLock(10000, () => {
      campusId = (campusId || '').trim();
      weekStr = normalizeWeekStr(weekStr);
      if (!campusId || !weekStr) return { success: false, error: '校園ID或週次不能為空' };
      if (!Array.isArray(records)) records = [];

      const memberData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const memberRoleMap = {};
      memberData.forEach(row => {
        if (String(row[0]).trim() === campusId) {
          memberRoleMap[String(row[2]).trim()] = String(row[3] || '').trim();
        }
      });

      const lastRow = this.adapter.getLastRow(SHEET_NAMES.ATTENDANCE);

      if (lastRow <= 1) {
        const newRows = [];
        for (const r of records) {
          const rName = String(r.name).trim();
          const rRole = String(r.role || memberRoleMap[rName] || '').trim();
          if (rName) newRows.push([campusId, rName, rRole, weekStr, String(r.type || '出席').trim()]);
        }
        this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, newRows, 2, 5);
        return { success: true };
      }

      // 指數退避探測 (Exponential Probing)
      const { sliceData, startFetchRow } = this._probeAttendanceSlice(weekStr, rPrime, lastRow);

      const remainingRows = [];
      for (let i = 0; i < sliceData.length; i++) {
        const rec = parseAttendanceRow(sliceData[i], memberRoleMap);
        if (!rec) continue;

        const normW = normalizeWeekStr(rec.week);
        if (rec.campusId === campusId && normW === weekStr) {
          continue;
        }
        remainingRows.push([rec.campusId, rec.name, rec.role, normW, rec.type]);
      }

      for (const r of records) {
        const rName = String(r.name).trim();
        const rRole = String(r.role || memberRoleMap[rName] || '').trim();
        if (rName) {
          remainingRows.push([campusId, rName, rRole, weekStr, String(r.type || '出席').trim()]);
        }
      }

      remainingRows.sort((a, b) => {
        const cmpW = a[3].localeCompare(b[3]);
        if (cmpW !== 0) return cmpW;
        const cmpC = a[0].localeCompare(b[0]);
        if (cmpC !== 0) return cmpC;
        return a[1].localeCompare(b[1]);
      });

      this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, remainingRows, startFetchRow, 5);
      return { success: true };
    });
  }

  /**
   * 11. 重新統計累計出席次數（最近 8 個相異週次）
   */
  recalculateAttendanceCounts(onlyRead = false) {
    try {
      const countMap = {};
      const lastRow = this.adapter.getLastRow(SHEET_NAMES.ATTENDANCE);

      if (lastRow > 1) {
        const chunkSize = 1500;
        const startRow = Math.max(2, lastRow - chunkSize + 1);
        const numRows = lastRow - startRow + 1;
        const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow, numRows, numCols: 5 });

        const distinctWeeks = new Set();
        for (let i = attData.length - 1; i >= 0; i--) {
          const row = attData[i];
          const week = normalizeWeekStr(row[3] || row[2]);
          if (!week) continue;

          if (!distinctWeeks.has(week)) {
            if (distinctWeeks.size >= 8) break;
            distinctWeeks.add(week);
          }

          const type = String(row[4] || row[3] || '').trim();
          if (type === '出席') {
            const campusId = String(row[0] || '').trim();
            const name     = String(row[1] || '').trim();
            if (campusId && name) {
              const key = campusId + '|' + name;
              countMap[key] = (countMap[key] || 0) + 1;
            }
          }
        }
      }

      const memberData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const counts2D = [];
      const membersByCampus = {};
      let hasDiff = false;

      for (let i = 0; i < memberData.length; i++) {
        const row = memberData[i];
        const campusId = String(row[0] || '').trim();
        const name     = String(row[2] || '').trim();
        const current  = Number(row[1]) || 0;
        const correct  = (campusId && name) ? (countMap[campusId + '|' + name] || 0) : 0;

        counts2D.push([correct]);
        if (correct !== current) hasDiff = true;

        if (!campusId || !name) continue;

        if (!membersByCampus[campusId]) membersByCampus[campusId] = [];
        const defaultsStr = String(row[5] || '').trim();
        membersByCampus[campusId].push({
          name: name,
          count: correct,
          role: String(row[3] || '').trim(),
          stage: String(row[4] || '').trim(),
          defaults: defaultsStr ? defaultsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
          otherGroupId: String(row[6] || '').trim()
        });
      }

      if (!onlyRead && hasDiff && counts2D.length > 0) {
        this.adapter.withLock(5000, () => {
          this.adapter.writeColumn(SHEET_NAMES.MEMBERS, 2, counts2D, 2);
        });
      }

      Object.values(membersByCampus).forEach(list => {
        list.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
      });

      return { success: true, data: { membersByCampus } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 12. 計算各啟用校園最後點名/暫停週次
   */
  getLastAttendanceWeeks() {
    try {
      const cData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const campusMap = {};
      let activeCampusCount = 0;

      for (let i = 0; i < cData.length; i++) {
        const id = String(cData[i][0]).trim();
        const name = String(cData[i][1]).trim();
        const isArchived = cData[i][4] === true || String(cData[i][4]).toUpperCase() === 'TRUE';
        if (!id || !name || isArchived) continue;

        const suspendedWeeks = parseSuspendedWeeks(cData[i][5]);
        const latestSuspendedWeek = suspendedWeeks.length > 0 ? suspendedWeeks[suspendedWeeks.length - 1] : '';

        campusMap[id] = {
          id: id,
          name: name,
          category: String(cData[i][2]).trim(),
          latestSuspendedWeek: latestSuspendedWeek,
          latestAttendedWeek: ''
        };
        activeCampusCount++;
      }

      const lastRow = this.adapter.getLastRow(SHEET_NAMES.ATTENDANCE);
      if (lastRow > 1 && activeCampusCount > 0) {
        const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numRows: lastRow - 1, numCols: 5 });
        let foundCount = 0;

        for (let i = attData.length - 1; i >= 0; i--) {
          const rowCampusId = String(attData[i][0]).trim();
          if (campusMap[rowCampusId] && !campusMap[rowCampusId].latestAttendedWeek) {
            const w = normalizeWeekStr(attData[i][3]);
            if (w) {
              campusMap[rowCampusId].latestAttendedWeek = w;
              foundCount++;
              if (foundCount >= activeCampusCount) {
                break;
              }
            }
          }
        }
      }

      const result = {};
      for (const id in campusMap) {
        const c = campusMap[id];
        const attWeek = c.latestAttendedWeek || '';
        const susWeek = c.latestSuspendedWeek || '';
        let latestWeek = '';
        let status = 'none';

        if (attWeek && susWeek) {
          if (attWeek >= susWeek) {
            latestWeek = attWeek;
            status = 'attended';
          } else {
            latestWeek = susWeek;
            status = 'suspended';
          }
        } else if (attWeek) {
          latestWeek = attWeek;
          status = 'attended';
        } else if (susWeek) {
          latestWeek = susWeek;
          status = 'suspended';
        }

        result[id] = {
          id: c.id,
          name: c.name,
          category: c.category,
          latestWeek: latestWeek || null,
          status: status,
          latestAttendedWeek: attWeek || null,
          latestSuspendedWeek: susWeek || null
        };
      }

      return {
        success: true,
        timestamp: new Date().toISOString(),
        data: result
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 13. 複合事務工作單元接縫 (Unit of Work Seam)
   */
  executeUnitOfWork(operation, timeoutMs = 30000) {
    return this.adapter.withLock(timeoutMs, () => operation(this));
  }

  /**
   * 14. 取得輕量校園清單（專供整併對話框等簡易選單使用，避免載入成員與大量點名紀錄）
   */
  getCampusesForDialog() {
    try {
      const campData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const campuses = [];
      campData.forEach(row => {
        const id = String(row[0] || '').trim();
        const name = String(row[1] || '').trim();
        const category = String(row[2] || '').trim();
        const sort = Number(row[3]) || 0;
        const isArchived = row[4] === true || String(row[4]).toUpperCase() === 'TRUE';
        if (id && name) {
          campuses.push({ id, name, category, sort, isArchived });
        }
      });
      campuses.sort((a, b) => a.sort - b.sort);
      return { success: true, data: campuses };
    } catch (e) {
      return { success: false, error: e.message, data: [] };
    }
  }

  /**
   * 15. 校園整併事務 (Merge Campuses)
   * 將來源校園的點名紀錄與成員遷移至目標校園，並刪除來源校園。
   * 注意鎖紀律：寫入三張工作表時鎖定，完成原子寫入後立即釋放鎖，再重算累計次數與產生報表（避免巢狀鎖與逾時）。
   * @param {string} sourceId
   * @param {string} targetId
   */
  mergeCampuses(sourceId, targetId) {
    sourceId = (sourceId || '').trim();
    targetId = (targetId || '').trim();

    if (!sourceId || !targetId) return { success: false, error: '來源與目標校園ID皆不能為空' };
    if (sourceId === targetId) return { success: false, error: '來源與目標校園不能相同' };

    // 階段一：在鎖保護下原子完成三張表的資料遷移與刪除
    const lockResult = this.adapter.withLock(30000, () => {
      // 1. 更新點名紀錄 campusId
      const attData = this.adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numCols: 5 });
      let attChanged = false;
      for (let i = 0; i < attData.length; i++) {
        if (String(attData[i][0]).trim() === sourceId) {
          attData[i][0] = targetId;
          attChanged = true;
        }
      }
      if (attChanged) {
        this.adapter.writeRows(SHEET_NAMES.ATTENDANCE, attData, 2, 5);
      }

      // 2. 遷移與合併人員名單
      const memData = this.adapter.readRows(SHEET_NAMES.MEMBERS, { startRow: 2, numCols: 7 });
      const targetMembers = {};
      const keptRows = [];

      for (let i = 0; i < memData.length; i++) {
        const cid = String(memData[i][0]).trim();
        const name = String(memData[i][2]).trim();
        if (cid === targetId) {
          targetMembers[name] = keptRows.length;
          keptRows.push(memData[i]);
        } else if (cid !== sourceId) {
          keptRows.push(memData[i]);
        }
      }

      for (let i = 0; i < memData.length; i++) {
        const cid = String(memData[i][0]).trim();
        const name = String(memData[i][2]).trim();
        if (cid === sourceId) {
          if (targetMembers[name] !== undefined) {
            const targetRowIdx = targetMembers[name];
            const existingDefaults = String(keptRows[targetRowIdx][5] || '').split(',').map(s => s.trim()).filter(Boolean);
            const sourceDefaults = String(memData[i][5] || '').split(',').map(s => s.trim()).filter(Boolean);
            const mergedDefaults = [...new Set([...existingDefaults, ...sourceDefaults])];
            keptRows[targetRowIdx][5] = mergedDefaults.join(',');
          } else {
            memData[i][0] = targetId;
            targetMembers[name] = keptRows.length;
            keptRows.push(memData[i]);
          }
        }
      }
      this.adapter.writeRows(SHEET_NAMES.MEMBERS, keptRows, 2, 7);

      // 3. 從校園列表移除 sourceId
      const campData = this.adapter.readRows(SHEET_NAMES.CAMPUSES, { startRow: 2, numCols: 6 });
      const finalCampData = campData.filter(r => String(r[0]).trim() !== sourceId);
      this.adapter.writeRows(SHEET_NAMES.CAMPUSES, finalCampData, 2, 6);

      return { success: true };
    });

    if (!lockResult || !lockResult.success) {
      return lockResult || { success: false, error: '校園整併原子寫入失敗' };
    }

    // 階段二：釋放鎖後執行次數重算與報表刷新（避免持鎖狀態下觸發二次鎖或長時間阻塞）
    try {
      this.recalculateAttendanceCounts(false);
    } catch (e) {
      console.warn('整併後重算出席次數警示: ' + e.message);
    }

    if (typeof internalGenerateAllSemesterReports === 'function') {
      try {
        const ss = getSpreadsheet();
        if (ss) internalGenerateAllSemesterReports(ss, false);
      } catch (e) {
        console.warn('整併後刷新報表警示: ' + e.message);
      }
    }

    return { success: true, message: `成功將校園 [${sourceId}] 的所有紀錄與成員整併至 [${targetId}]，並已從校園列表清除！` };
  }
}

// ==========================================
// ===== 模組四：全域預設倉儲與外部呼叫端轉發 =====
// ==========================================

let defaultRepositoryInstance = null;

/**
 * 取得或初始化全域 SpreadsheetRepository 實例
 * @returns {SpreadsheetRepository}
 */
function getDefaultRepository() {
  if (!defaultRepositoryInstance) {
    defaultRepositoryInstance = new SpreadsheetRepository();
  }
  return defaultRepositoryInstance;
}

/**
 * 設定全域 SpreadsheetRepository 實例（供依賴注入或單元測試）
 * @param {SpreadsheetRepository} repo 
 */
function setDefaultRepository(repo) {
  defaultRepositoryInstance = repo;
}

/** 初始化試算表結構 */
function initializeSheet() {
  return getDefaultRepository().initializeSheet();
}

/**
 * 處理 HTTP GET 請求
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'getLastAttendanceWeeks') {
    const result = getLastAttendanceWeeks();
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const template = HtmlService.createTemplateFromFile('index');
  try {
    const initialResult = getInitialAppData();
    template.initialData = initialResult.success ? initialResult.data : null;
  } catch (err) {
    template.initialData = null;
  }
  return template.evaluate()
    .setTitle('小排點名')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 供 GAS 樣板引擎在伺服器端動態引入模組化檔案（HTML / CSS / JS）
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 一次性讀取首頁必要資料（委派至 Repository）
 * @returns {{ success: boolean, data?: { campuses: Array, archivedCampuses: Array, membersByCampus: Object, attendanceByCampus: Object, minLoadedWeek: string, maxAllowedSundayStr: string }, error?: string }}
 */
function getInitialAppData() {
  return getDefaultRepository().loadInitialSnapshot();
}

/**
 * 查詢指定區間之歷史點名紀錄（委派至 Repository）
 * @param {string} campusId 目標校園 ID（傳入空字串或未提供代表全體校園）
 * @param {string} startWeek 起始週一日期 (YYYY-MM-DD)
 * @param {string} endWeek 結束週一日期 (YYYY-MM-DD)
 * @returns {{ success: boolean, data?: { attendanceByCampus: Object.<string, Array>, hasMore: boolean }, error?: string }}
 */
function getAttendanceHistory(campusId, startWeek, endWeek) {
  return getDefaultRepository().queryAttendanceHistory(campusId, startWeek, endWeek);
}

/**
 * 取得特定校園最新人員名單（委派至 Repository）
 * @param {string} campusId 校園 ID
 * @returns {{ success: boolean, members?: Array, error?: string }}
 */
function getCampusMembersFresh(campusId) {
  return getDefaultRepository().getCampusMembersFresh(campusId);
}

/**
 * 批次儲存校園清單（委派至 Repository）
 * @param {Array<Object>} campusList 完整校園物件清單
 * @returns {{ success: boolean, error?: string }}
 */
function applyCampusChanges(campusList) {
  return getDefaultRepository().syncCampuses(campusList);
}

/**
 * 封存特定校園（軟刪除，委派至 Repository）
 * @param {string} campusId 校園 ID
 * @returns {{ success: boolean, error?: string }}
 */
function deleteCampus(campusId) {
  return getDefaultRepository().setCampusArchivedStatus(campusId, true);
}

/**
 * 恢復已封存之校園（委派至 Repository）
 * @param {string} campusId 校園 ID
 * @returns {{ success: boolean, error?: string }}
 */
function restoreCampus(campusId) {
  return getDefaultRepository().setCampusArchivedStatus(campusId, false);
}

/**
 * 設定校園封存狀態（委派至 Repository）
 * @param {string} campusId 校園 ID
 * @param {boolean} isArchived 是否封存
 * @returns {{ success: boolean, error?: string }}
 */
function setCampusArchivedStatus(campusId, isArchived) {
  return getDefaultRepository().setCampusArchivedStatus(campusId, isArchived);
}

/**
 * 切換特定小排特定週次暫停狀態（委派至 Repository）
 * @param {string} campusId 校園 ID
 * @param {string} weekStr 週一日期 (YYYY-MM-DD)
 * @param {boolean} isSuspended 是否暫停
 * @returns {{ success: boolean, isSuspended?: boolean, error?: string }}
 */
function toggleCampusSuspension(campusId, weekStr, isSuspended) {
  return getDefaultRepository().toggleCampusSuspension(campusId, weekStr, isSuspended);
}

/**
 * 批次儲存人員變更（社區排雙向關聯 + 校園排隔離 + 點名表改名連動，委派至 Repository）
 * @param {string} campusId 校園 ID
 * @param {{ changes: Array<Object> }} diffPayload 變更清單封裝
 * @returns {{ success: boolean, members?: Array, affectedMembers?: Array, warnings?: Array, error?: string }}
 */
function applyMemberChanges(campusId, diffPayload) {
  return getDefaultRepository().syncMembers(campusId, diffPayload);
}

/**
 * 一鍵套用預設紀錄至該週（委派至 Repository）
 * @param {string} campusId 校園 ID
 * @param {string} weekStr 目標週一日期 (YYYY-MM-DD)
 * @param {Array<Object>} records 預設紀錄清單
 * @param {number} [rPrime=0] 大於等於目標週次之紀錄筆數估算值
 * @returns {{ success: boolean, error?: string }}
 */
function applyDefaultAttendance(campusId, weekStr, records, rPrime) {
  return getDefaultRepository().applyDefaultAttendance(campusId, weekStr, records, rPrime);
}

/**
 * 批次更新點名紀錄（指數退避探測 + 原位覆寫 + 尾部殘留清除，委派至 Repository）
 * @param {string} campusId 校園 ID
 * @param {string} weekStr 週一日期 (YYYY-MM-DD)
 * @param {Array<Object>} marks 新增點名標記
 * @param {Array<Object>} unmarks 取消點名標記
 * @param {number} [rPrime=0] 大於等於目標週次之紀錄筆數估算值
 * @returns {{ success: boolean, error?: string }}
 */
function batchUpdateAttendance(campusId, weekStr, marks, unmarks, rPrime) {
  return getDefaultRepository().syncAttendance(campusId, weekStr, marks, unmarks, rPrime);
}

/**
 * 定時觸發器專用函式：定期校準人員累計出席次數（最近 8 個相異週次）
 * 供 Google Apps Script「時間驅動」觸發條件每日定時呼叫（例如每日凌晨 02:00~04:00 執行）
 * @returns {{ success: boolean, updatedCount?: number, error?: string }}
 */
function scheduledSyncAttendanceCounts() {
  return getDefaultRepository().recalculateAttendanceCounts(false);
}

/**
 * 計算各啟用校園最後點名與暫停週次（委派至 Repository）
 * @returns {{ success: boolean, data?: Object.<string, { latestAttendedWeek: string|null, isSuspended: boolean, isArchived: boolean }>, error?: string }}
 */
function getLastAttendanceWeeks() {
  return getDefaultRepository().getLastAttendanceWeeks();
}

// ==========================================
// ===== 模組五：試算表選單與校園整併工具 =====
// ==========================================

/** 試算表開啟時建立自訂功能選單 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('📊 點名統計系統')
      .addItem('🔄 產出 / 刷新所有學期報表', 'menuGenerateSemesterReports')
      .addSeparator()
      .addItem('🔄 校準人員出席次數 (最近8週)', 'scheduledSyncAttendanceCounts')
      .addSeparator()
      .addItem('🔗 整併重複校園', 'showMergeCampusesDialog')
      .addToUi();
  } catch (e) {}
}

/** 選單點擊觸發：手動產出所有學期報表 */
function menuGenerateSemesterReports() {
  generateAllSemesterReports(true);
}

/** 讀取校園清單供整併對話框使用（輕量讀取，不加載成員或大量點名） */
function getCampusesForMergeDialog() {
  const res = getDefaultRepository().getCampusesForDialog();
  return res.success ? res.data : [];
}

/** 顯示【整併重複校園】對話框 */
function showMergeCampusesDialog() {
  const campuses = getCampusesForMergeDialog();
  const campusesJson = JSON.stringify(campuses);

  const html = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
    <head>
      <base target="_top">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; color: #1e293b; font-size: 14px; }
        h3 { margin-top: 0; color: #0f172a; display: flex; align-items: center; gap: 6px; }
        .form-group { margin-bottom: 16px; }
        label { display: block; font-weight: 600; margin-bottom: 6px; }
        select { width: 100%; padding: 8px 10px; border: 1.5px solid #cbd5e1; border-radius: 6px; font-size: 14px; box-sizing: border-box; background: white; }
        select:focus { border-color: #0d9488; outline: none; }
        .tip { font-size: 12px; color: #64748b; margin-top: 4px; }
        .warning-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px; color: #991b1b; font-size: 12.5px; margin-bottom: 16px; line-height: 1.4; }
        .btn-bar { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
        button { padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; }
        .btn-cancel { background: #e2e8f0; color: #334155; }
        .btn-primary { background: #0d9488; color: white; }
        .btn-primary:hover { background: #0f766e; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .loading { display: none; text-align: center; color: #0d9488; font-weight: bold; margin-top: 10px; }
      </style>
    </head>
    <body>
      <h3>🔗 整併重複校園</h3>
      
      <div class="form-group">
        <label>1. 選擇要被整併（消除）的來源校園：</label>
        <select id="sourceSelect" onchange="validate()"></select>
        <div class="tip">此校園的所有點名紀錄與成員將轉移至目標校園，並從列表移除。</div>
      </div>

      <div class="form-group">
        <label>2. 選擇保留的主要目標校園：</label>
        <select id="targetSelect" onchange="validate()"></select>
        <div class="tip">此校園將作為主體保留，接收來源校園的所有歷史紀錄。</div>
      </div>

      <div class="warning-box">
        ⚠️ 注意：此操作會將來源校園的點名紀錄與成員遷移至目標校園，並清除來源校園，執行後將自動重新統計全學期報表。
      </div>

      <div id="loadingDiv" class="loading">正在執行整併與報表重算中，請稍候...</div>

      <div class="btn-bar" id="btnBar">
        <button class="btn-cancel" onclick="google.script.host.close()">取消</button>
        <button class="btn-primary" id="submitBtn" disabled onclick="doMerge()">確認整併</button>
      </div>

      <script>
        const initialCampuses = ${campusesJson};

        /** 填充來源與目標校園下拉選單 */
        function populateSelects(campuses) {
          const sSelect = document.getElementById('sourceSelect');
          const tSelect = document.getElementById('targetSelect');
          sSelect.innerHTML = '<option value="">-- 請選擇來源校園 --</option>';
          tSelect.innerHTML = '<option value="">-- 請選擇目標校園 --</option>';

          (campuses || []).forEach(c => {
            const arch = c.isArchived ? ' (已封存)' : '';
            const opt1 = new Option(c.name + ' [' + c.id + ']' + arch, c.id);
            const opt2 = new Option(c.name + ' [' + c.id + ']' + arch, c.id);
            sSelect.add(opt1);
            tSelect.add(opt2);
          });
          validate();
        }

        populateSelects(initialCampuses);

        /** 驗證整併表單選擇（來源與目標不可為空且不可相同） */
        function validate() {
          const s = document.getElementById('sourceSelect').value;
          const t = document.getElementById('targetSelect').value;
          const btn = document.getElementById('submitBtn');
          btn.disabled = (!s || !t || s === t);
        }

        /** 執行整併呼叫並處理載入狀態與結果反饋 */
        function doMerge() {
          const s = document.getElementById('sourceSelect').value;
          const t = document.getElementById('targetSelect').value;
          if (!s || !t || s === t) return;

          document.getElementById('loadingDiv').style.display = 'block';
          document.getElementById('btnBar').style.display = 'none';

          google.script.run
            .withSuccessHandler(function(res) {
              if (res.success) {
                alert('✅ ' + res.message);
                google.script.host.close();
              } else {
                alert('❌ 整併失敗：' + res.error);
                document.getElementById('loadingDiv').style.display = 'none';
                document.getElementById('btnBar').style.display = 'flex';
              }
            })
            .withFailureHandler(function(err) {
              alert('❌ 發生錯誤：' + err.message);
              document.getElementById('loadingDiv').style.display = 'none';
              document.getElementById('btnBar').style.display = 'flex';
            })
            .executeMergeCampuses(s, t);
        }
      </script>
    </body>
    </html>
  `)
  .setWidth(480)
  .setHeight(430);

  SpreadsheetApp.getUi().showModalDialog(html, '🔗 整併重複校園');
}

/**
 * 執行校園整併（委派至 Repository 核心方法）
 * @param {string} sourceId
 * @param {string} targetId
 */
function executeMergeCampuses(sourceId, targetId) {
  return getDefaultRepository().mergeCampuses(sourceId, targetId);
}

// ===== 模組六：多學期統計報表產出引擎 =====
// ==========================================

/**
 * 依週次日期判斷所屬學期（如：'2026|上半年'）
 * 上半年：2月至7月；下半年：8月至次年1月
 * @param {string} weekStr 
 * @returns {string|null}
 */
function getSemesterKeyFromWeek(weekStr) {
  const norm = normalizeWeekStr(weekStr);
  if (!norm) return null;
  const parts = norm.split('-');
  if (parts.length < 3) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  if (month >= 2 && month <= 7) {
    return `${year}|上半年`;
  } else if (month >= 8 && month <= 12) {
    return `${year}|下半年`;
  } else if (month === 1) {
    return `${year - 1}|下半年`;
  }
  return null;
}

/**
 * 產出特定學期的所有標準月份與涵蓋週次（上半年 3~6月；下半年 9~12月）
 * 智慧容納跨月邊界週次（如：2月跨至3月、6月跨至7月、8月跨至9月、12月跨至次年1月）
 * @param {number} year 
 * @param {boolean} isSpring true=上半年(3~6月), false=下半年(9~12月)
 * @returns {{ months: Array<number>, monthWeeks: Object.<number, Array> }}
 */
function getSemesterWeeks(year, isSpring) {
  const months = isSpring ? [3, 4, 5, 6] : [9, 10, 11, 12];
  const monthWeeks = {};
  months.forEach(m => { monthWeeks[m] = []; });
  const cnNums = ['一', '二', '三', '四', '五', '六'];

  // 起始計算日：起始月份（3月或9月）1號所屬該週的週一
  const startM = months[0];
  const firstDay = new Date(year, startM - 1, 1);
  const day = firstDay.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const curr = new Date(year, startM - 1, 1 + diffToMon);
  curr.setHours(0, 0, 0, 0);

  // 結束計算日：結束月份（6月或12月）最後一天的日期
  const endM = months[months.length - 1];
  const lastDay = new Date(year, endM, 0); // 該月最後一天

  while (curr <= lastDay) {
    const sunday = new Date(curr);
    sunday.setDate(curr.getDate() + 6);

    const thursday = new Date(curr);
    thursday.setDate(curr.getDate() + 3);

    let targetM = thursday.getMonth() + 1;
    const targetY = thursday.getFullYear();

    // 跨月份邊界容納規則：
    // 1. 上半年第一週從 2 月跨至 3 月（週四在2月但週日在3月）➔ 納入 3 月第一週
    if (isSpring && (curr.getMonth() + 1) === 2 && (sunday.getMonth() + 1) === 3) {
      targetM = 3;
    }
    // 2. 下半年第一週從 8 月跨至 9 月（週四在8月但週日在9月）➔ 納入 9 月第一週
    else if (!isSpring && (curr.getMonth() + 1) === 8 && (sunday.getMonth() + 1) === 9) {
      targetM = 9;
    }
    // 3. 上半年最後一週從 6 月跨至 7 月（週四在7月但週一在6月）➔ 納入 6 月最後一週
    if (isSpring && (curr.getMonth() + 1) === 6 && (sunday.getMonth() + 1) === 7) {
      targetM = 6;
    }
    // 4. 下半年最後一週從 12 月跨至次年 1 月（週日在1月但週一在12月）➔ 納入 12 月最後一週
    else if (!isSpring && (curr.getMonth() + 1) === 12 && ((sunday.getMonth() + 1) === 1 || sunday.getFullYear() > year)) {
      targetM = 12;
    }

    if (monthWeeks[targetM]) {
      const weekIdx = monthWeeks[targetM].length + 1;
      const cnNum = weekIdx <= cnNums.length ? cnNums[weekIdx - 1] : String(weekIdx);

      const monStr = normalizeWeekStr(curr);
      const sunStr = normalizeWeekStr(sunday);
      const label = `第${cnNum}週\n${curr.getFullYear()}/${curr.getMonth() + 1}/${curr.getDate()}\n～\n${sunday.getFullYear()}/${sunday.getMonth() + 1}/${sunday.getDate()}`;

      monthWeeks[targetM].push({
        monday: monStr,
        sunday: sunStr,
        month: targetM,
        weekNum: `第${cnNum}週`,
        label: label
      });
    }

    curr.setDate(curr.getDate() + 7);
  }

  return { months: months, monthWeeks: monthWeeks };
}

/**
 * 建立單一學期統計報表工作表（高效 2D 矩陣批次著色與極速單次欄寬設定）
 */
function buildSemesterReportSheet(ss, sheetTitle, year, isSpring, campuses, memberRoleMap, attendanceRecords) {
  const semInfo = getSemesterWeeks(year, isSpring);
  const months = semInfo.months;
  const monthWeeks = semInfo.monthWeeks;

  // 1. 建立 attendanceRecords 索引
  const lookup = {};
  const recordRoleMap = {};

  for (const r of attendanceRecords) {
    const key = r.campusId + '|' + r.week + '|' + r.type;
    if (!lookup[key]) lookup[key] = new Set();
    lookup[key].add(r.name);
    if (r.role) {
      recordRoleMap[r.campusId + '|' + r.week + '|' + r.name] = r.role;
    }
  }

  // 2. 構建表頭
  const row1 = ['單位', '項目'];
  const row2 = ['', ''];
  const monthColumnsInfo = [];
  let colIdx = 2;
  let totalWeeksCount = 0;

  for (const m of months) {
    const weeks = monthWeeks[m] || [];
    if (weeks.length === 0) continue;

    const startCol = colIdx;
    row1.push(`${year}年${m}月`);
    for (let i = 1; i < weeks.length; i++) row1.push('');
    row1.push(''); // 平均欄位

    for (const w of weeks) row2.push(w.label);
    row2.push('平均');

    const avgCol = startCol + weeks.length;
    monthColumnsInfo.push({
      month: m,
      startCol: startCol,
      weeksCount: weeks.length,
      avgCol: avgCol,
      weeks: weeks
    });

    totalWeeksCount += weeks.length;
    colIdx = avgCol + 1;
  }

  const semAvgTitle = `${months[0]}~${months[months.length - 1]}平均`;
  row1.push('');
  row2.push(semAvgTitle);
  const semAvgColIdx = colIdx;
  const totalCols = row1.length;

  // 3. 逐校計算各項目數據
  const metrics = [
    { key: 'attend',  name: '小排參加人數' },
    { key: 'friends', name: '福音朋友人數' },
    { key: 'pray',    name: '校園禱告人數' },
    { key: 'gospel',  name: '福音出訪人數' }
  ];

  const campusRowsData = [];

  for (const campus of campuses) {
    const cRows = {};
    metrics.forEach(m => cRows[m.key] = []);

    let totalActiveMeetings = 0;
    const metricSumsAcrossSemester = { attend: 0, friends: 0, pray: 0, gospel: 0 };

    for (const mInfo of monthColumnsInfo) {
      let monthActiveMeetings = 0;
      const metricSumsInMonth = { attend: 0, friends: 0, pray: 0, gospel: 0 };

      for (const w of mInfo.weeks) {
        const attendSet = lookup[campus.id + '|' + w.monday + '|出席'] || new Set();
        const praySet   = lookup[campus.id + '|' + w.monday + '|禱告'] || new Set();
        const gospelSet = lookup[campus.id + '|' + w.monday + '|傳福音'] || new Set();

        const attendCount = attendSet.size;
        let friendsCount = 0;
        attendSet.forEach(name => {
          const role = recordRoleMap[campus.id + '|' + w.monday + '|' + name] || memberRoleMap[campus.id + '|' + name] || '';
          if (role === '男界朋友' || role === '女界朋友') {
            friendsCount++;
          }
        });
        const prayCount = praySet.size;
        const gospelCount = gospelSet.size;

        if (attendCount > 0) {
          monthActiveMeetings++;
          totalActiveMeetings++;
          cRows.attend.push(attendCount);
          cRows.friends.push(friendsCount);
          metricSumsInMonth.attend += attendCount;
          metricSumsInMonth.friends += friendsCount;
        } else {
          cRows.attend.push('');
          cRows.friends.push('');
        }

        if (attendCount === 0 && prayCount === 0) {
          cRows.pray.push('');
        } else {
          cRows.pray.push(prayCount);
          metricSumsInMonth.pray += prayCount;
        }

        if (attendCount === 0 && gospelCount === 0) {
          cRows.gospel.push('');
        } else {
          cRows.gospel.push(gospelCount);
          metricSumsInMonth.gospel += gospelCount;
        }
      }

      // 月平均：除以實際有聚會的小排次數
      metrics.forEach(m => {
        const sum = metricSumsInMonth[m.key];
        metricSumsAcrossSemester[m.key] += sum;
        const avg = monthActiveMeetings > 0 ? Math.round(sum / monthActiveMeetings) : 0;
        cRows[m.key].push(avg);
      });
    }

    // 全學期平均：除以全學期實際有聚會的小排次數
    metrics.forEach(m => {
      const sum = metricSumsAcrossSemester[m.key];
      const avg = totalActiveMeetings > 0 ? Math.round(sum / totalActiveMeetings) : 0;
      cRows[m.key].push(avg);
    });

    campusRowsData.push({ campus: campus, rows: cRows });
  }

  // 4. 計算全會所總人數
  const totalRows = { attend: [], friends: [], pray: [], gospel: [] };

  for (let c = 2; c < totalCols; c++) {
    let isMonthAvg = false;
    let monthWeeksCount = 0;
    for (const mInfo of monthColumnsInfo) {
      if (c === mInfo.avgCol) {
        isMonthAvg = true;
        monthWeeksCount = mInfo.weeksCount;
        break;
      }
    }
    const isSemAvg = (c === semAvgColIdx);

    if (isMonthAvg) {
      metrics.forEach(m => {
        let monthSum = 0;
        for (const mInfo of monthColumnsInfo) {
          if (c === mInfo.avgCol) {
            for (let wc = mInfo.startCol; wc < mInfo.avgCol; wc++) {
              monthSum += Number(totalRows[m.key][wc - 2]) || 0;
            }
            break;
          }
        }
        totalRows[m.key].push(monthWeeksCount > 0 ? Math.round(monthSum / monthWeeksCount) : 0);
      });
    } else if (isSemAvg) {
      metrics.forEach(m => {
        let semSum = 0;
        for (const mInfo of monthColumnsInfo) {
          for (let wc = mInfo.startCol; wc < mInfo.avgCol; wc++) {
            semSum += Number(totalRows[m.key][wc - 2]) || 0;
          }
        }
        totalRows[m.key].push(totalWeeksCount > 0 ? Math.round(semSum / totalWeeksCount) : 0);
      });
    } else {
      metrics.forEach(m => {
        let weekSum = 0;
        for (const cr of campusRowsData) {
          const val = cr.rows[m.key][c - 2];
          if (typeof val === 'number') weekSum += val;
        }
        totalRows[m.key].push(weekSum);
      });
    }
  }

  // 5. 組合最終表格二維矩陣
  const finalData = [row1, row2];

  metrics.forEach((m, idx) => {
    finalData.push([idx === 0 ? '總人數' : '', m.name, ...totalRows[m.key]]);
  });

  for (const cr of campusRowsData) {
    metrics.forEach((m, idx) => {
      finalData.push([idx === 0 ? cr.campus.name : '', m.name, ...cr.rows[m.key]]);
    });
  }

  // 6. 寫入試算表
  let sheet = ss.getSheetByName(sheetTitle);
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet(sheetTitle);
  }

  const numRows = finalData.length;
  sheet.getRange(1, 1, numRows, totalCols).setValues(finalData);

  // 7. 高效 2D 背景顏色矩陣構建（單次 setBackgrounds 呼叫）
  const bgMatrix = [];
  for (let r = 0; r < numRows; r++) {
    const rowColors = new Array(totalCols).fill('#ffffff');
    if (r < 2) {
      rowColors.fill('#d9ead3'); // 表頭綠色
    } else if (r >= 2 && r < 6) {
      rowColors.fill('#f4cccc'); // 總人數粉紅色
    } else {
      const cIdx = Math.floor((r - 6) / 4);
      if (cIdx < campusRowsData.length) {
        const cr = campusRowsData[cIdx];
        const cat = cr.campus.category;
        let cBg = '#ffffff';
        if (cat === '高中' || /高中|高職|女中|一中|二中|中學|海事|醫專/.test(cr.campus.name)) {
          cBg = '#fff2cc'; // 高中黃色
        } else if (cat === '國中' || cr.campus.name.includes('國中')) {
          cBg = '#cfe2f3'; // 國中藍色
        }
        rowColors[0] = cBg;
        rowColors[1] = cBg;
      }
    }
    bgMatrix.push(rowColors);
  }
  sheet.getRange(1, 1, numRows, totalCols).setBackgrounds(bgMatrix);

  // 8. 批次格式化與樣式套用
  // (a) 合併表頭與單位名稱
  for (const mInfo of monthColumnsInfo) {
    if (mInfo.weeksCount > 1) {
      sheet.getRange(1, mInfo.startCol + 1, 1, mInfo.weeksCount).merge();
    }
  }
  sheet.getRange(3, 1, 4, 1).merge(); // 總人數
  for (let i = 0; i < campusRowsData.length; i++) {
    sheet.getRange(7 + i * 4, 1, 4, 1).merge();
  }

  // (b) 字體加粗與對齊
  sheet.getRange(1, 1, 2, totalCols)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  sheet.getRange(3, 1, 4, totalCols)
    .setFontWeight('bold');

  sheet.getRange(1, 1, numRows, 2).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(3, 3, numRows - 2, totalCols - 2).setHorizontalAlignment('center').setVerticalAlignment('middle');

  // (c) 邊框設置
  const fullRange = sheet.getRange(1, 1, numRows, totalCols);
  fullRange.setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  fullRange.setBorder(true, true, true, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.getRange(1, 1, 2, totalCols).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.getRange(3, 1, 4, totalCols).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  for (let i = 0; i < campusRowsData.length; i++) {
    sheet.getRange(7 + i * 4, 1, 4, totalCols).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
  sheet.getRange(1, 2, numRows, 1).setBorder(null, null, null, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  for (const mInfo of monthColumnsInfo) {
    sheet.getRange(1, mInfo.avgCol + 1, numRows, 1).setBorder(null, true, null, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
  sheet.getRange(1, semAvgColIdx + 1, numRows, 1).setBorder(null, true, null, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // (d) 一次性極速批次欄寬設定（日期欄位 80px，平均欄位 50px）
  sheet.setColumnWidth(1, 105);
  sheet.setColumnWidth(2, 105);
  if (totalCols > 2) {
    sheet.setColumnWidths(3, totalCols - 2, 80); // 先將所有日期欄位批次設為 80px
  }
  // 將各月平均欄與學期總平均欄位精確設為 50px
  for (const mInfo of monthColumnsInfo) {
    sheet.setColumnWidth(mInfo.avgCol + 1, 50);
  }
  sheet.setColumnWidth(semAvgColIdx + 1, 50);

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(2);
}

/**
 * 內部通用：依跨學期建立或覆蓋各學期報表分頁（不重複取得 Lock，供 executeMergeCampuses 或 generateAllSemesterReports 調用）
 */
function internalGenerateAllSemesterReports(ss, showUiAlert) {
  showUiAlert = showUiAlert || false;
  const campusSheet     = ss.getSheetByName(SHEET_NAMES.CAMPUSES);
  const memberSheet     = ss.getSheetByName(SHEET_NAMES.MEMBERS);
  const attendanceSheet = ss.getSheetByName(SHEET_NAMES.ATTENDANCE);

  if (!campusSheet || !memberSheet || !attendanceSheet) {
    throw new Error('缺少必要的基礎工作表');
  }

  // 1. 讀取未封存校園
  const campusData = campusSheet.getDataRange().getValues();
  const campuses = [];
  for (let i = 1; i < campusData.length; i++) {
    const id = String(campusData[i][0]).trim();
    const name = String(campusData[i][1]).trim();
    const category = String(campusData[i][2]).trim();
    const sort = Number(campusData[i][3]) || 0;
    const isArchived = campusData[i][4] === true || String(campusData[i][4]).toUpperCase() === 'TRUE';
    if (id && name && !isArchived && !CampusDomain.isCommunity(category)) campuses.push({ id: id, name: name, category: category, sort: sort });
  }
  campuses.sort((a, b) => {
    if (a.category === '高中' && b.category !== '高中') return -1;
    if (a.category !== '高中' && b.category === '高中') return 1;
    return a.sort - b.sort;
  });

  // 2. 讀取人員身分對照表
  const memberData = memberSheet.getDataRange().getValues();
  const memberRoleMap = {};
  for (let i = 1; i < memberData.length; i++) {
    const cid = String(memberData[i][0]).trim();
    const name = String(memberData[i][2]).trim();
    const role = String(memberData[i][3] || '').trim();
    if (cid && name) memberRoleMap[cid + '|' + name] = role;
  }

  // 3. 讀取點名紀錄並收集所有學期
  const attData = attendanceSheet.getDataRange().getValues();
  const attendanceRecords = [];
  const semesterSet = new Set();

  for (let i = 1; i < attData.length; i++) {
    const rec = parseAttendanceRow(attData[i], memberRoleMap);
    if (!rec) continue;
    attendanceRecords.push(rec);

    const semKey = getSemesterKeyFromWeek(rec.week);
    if (semKey) semesterSet.add(semKey);
  }

  if (semesterSet.size === 0) {
    const now = new Date();
    const isSpring = (now.getMonth() + 1) >= 2 && (now.getMonth() + 1) <= 7;
    semesterSet.add(`${now.getFullYear()}|${isSpring ? '上半年' : '下半年'}`);
  }

  const generatedSheets = [];

  // 4. 為各學期產出報表
  for (const semKey of semesterSet) {
    const parts = semKey.split('|');
    const year = parseInt(parts[0], 10);
    const semName = parts[1];
    const sheetTitle = `${year}${semName}`;

    buildSemesterReportSheet(ss, sheetTitle, year, semName === '上半年', campuses, memberRoleMap, attendanceRecords);
    generatedSheets.push(sheetTitle);
  }

  if (showUiAlert) {
    try {
      SpreadsheetApp.getUi().alert(`✅ 統計報表產生成功！\n已更新 ${generatedSheets.length} 個學期分頁：\n${generatedSheets.join('、')}`);
    } catch (uiErr) {}
  }

  return { success: true, message: `已成功更新報表：${generatedSheets.join('、')}`, sheets: generatedSheets };
}

/**
 * 自動依跨學期建立或覆蓋各學期報表分頁（如：2026上半年、2026下半年）
 * @param {boolean} showUiAlert 是否主動跳出 UI Alert 提示
 */
function generateAllSemesterReports(showUiAlert) {
  showUiAlert = showUiAlert || false;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    const errorMsg = '系統目前繁忙（其他使用者正在同步資料），請稍候片刻再試';
    if (showUiAlert) {
      try {
        SpreadsheetApp.getUi().alert(`❌ 報表產生失敗：${errorMsg}`);
      } catch (uiErr) {}
    }
    return { success: false, error: errorMsg };
  }
  try {
    const ss = getSpreadsheet();
    return internalGenerateAllSemesterReports(ss, showUiAlert);
  } catch (e) {
    if (showUiAlert) {
      try {
        SpreadsheetApp.getUi().alert(`❌ 報表產生失敗：${e.message}`);
      } catch (uiErr) {}
    }
    return { success: false, error: e.message };
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {}
  }
}
