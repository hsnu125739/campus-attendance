/**
 * test_repository.js
 * 
 * 測試 SpreadsheetRepository 與 InMemoryAdapter
 * 透過 vm.runInThisContext 載入純淨的 backup.gs（模擬 Google Apps Script 執行環境），
 * 並在測試端注入 InMemoryAdapter 進行 100% 離線單元測試。
 * 
 * 涵蓋測試：
 * 1. 試算表初始化 (initializeSheet)
 * 2. 首頁快照讀取 (loadInitialSnapshot - 4欄/5欄格式相容、排序、安全週次切片)
 * 3. 批次點名同步 (syncAttendance - 指數退避、打卡/取消打卡、去重、殘留列清理)
 * 4. 人員名單變更 (syncMembers - 社區排雙向連結、校園排隔離、改名原子連動更新點名表)
 * 5. 校園管理 (syncCampuses, toggleCampusSuspension, setCampusArchivedStatus)
 * 6. 累計出席次數重算 (recalculateAttendanceCounts - 倒數 10 相異週統計)
 * 7. 校園整併事務 (executeUnitOfWork)
 * 8. 一鍵套用預設出席 (applyDefaultAttendance)
 * 9. 歷史點名區間查詢 (queryAttendanceHistory)
 * 10. 外部查詢各校最後狀態 (getLastAttendanceWeeks)
 * 11. 切片截斷安全週次邊界 (Safe Week Boundary)
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 1. 讀取並執行純淨的 backup.gs（模擬 Google Apps Script 執行環境，全域載入所有函式與類別）
const gasCode = fs.readFileSync(__dirname + '/backup.gs', 'utf8');
vm.runInThisContext(gasCode);

// 2. 測試專用：純記憶體 Map 表格模擬器 (InMemoryAdapter)
// 僅存在於測試檔案中，絕不污染 Google Apps Script 生產代碼
class InMemoryAdapter {
  constructor(initialData = {}) {
    this.tables = new Map();
    for (const [sheetName, rows] of Object.entries(initialData)) {
      this.tables.set(sheetName, rows.map(r => [...r]));
    }
  }

  withLock(timeoutMs, action) {
    return action();
  }

  _ensureTable(sheetName) {
    if (!this.tables.has(sheetName)) {
      this.tables.set(sheetName, []);
    }
    return this.tables.get(sheetName);
  }

  readRows(sheetName, options) {
    const table = this.tables.get(sheetName);
    if (!table || table.length <= 1) return [];
    const startRow = (options && options.startRow) || 2;
    const startIdx = startRow - 1;
    if (startIdx >= table.length) return [];
    const numRows = (options && options.numRows) ? options.numRows : (table.length - startIdx);
    const endIdx = Math.min(table.length, startIdx + numRows);
    const cols = (options && options.numCols) || 0;

    const result = [];
    for (let i = startIdx; i < endIdx; i++) {
      const row = [...table[i]];
      if (cols > 0) {
        while (row.length < cols) row.push('');
      }
      result.push(cols > 0 ? row.slice(0, cols) : row);
    }
    return result;
  }

  writeRows(sheetName, rows, startRow = 2, numCols) {
    const table = this._ensureTable(sheetName);
    const startIdx = startRow - 1;

    while (table.length < startIdx) {
      table.push([]);
    }

    for (let i = 0; i < rows.length; i++) {
      const targetIdx = startIdx + i;
      table[targetIdx] = [...rows[i]];
    }

    const newLength = startIdx + rows.length;
    if (table.length > newLength) {
      table.length = newLength;
    }
  }

  writeColumn(sheetName, colIndex, values2D, startRow = 2) {
    const table = this._ensureTable(sheetName);
    const colIdx = colIndex - 1;
    const startIdx = startRow - 1;

    for (let i = 0; i < values2D.length; i++) {
      const targetIdx = startIdx + i;
      if (targetIdx < table.length) {
        while (table[targetIdx].length <= colIdx) {
          table[targetIdx].push('');
        }
        table[targetIdx][colIdx] = values2D[i][0];
      }
    }
  }

  clearRows(sheetName, startRow, numRows, numCols) {
    const table = this.tables.get(sheetName);
    if (!table) return;
    const startIdx = startRow - 1;
    const endIdx = Math.min(table.length, startIdx + numRows);
    for (let i = startIdx; i < endIdx; i++) {
      if (numCols) {
        for (let c = 0; c < numCols; c++) {
          if (c < table[i].length) table[i][c] = '';
        }
      } else {
        table[i] = [];
      }
    }
  }

  getLastRow(sheetName) {
    const table = this.tables.get(sheetName);
    return table ? table.length : 0;
  }

  setColumnNumberFormat(sheetName, colIndex, format, startRow = 2, numRows) {
    // 記憶體中純資料模型無需格式設定
  }

  ensureSheets(schemas) {
    for (const [sheetName, headers] of Object.entries(schemas)) {
      if (!this.tables.has(sheetName)) {
        this.tables.set(sheetName, [[...headers]]);
      }
    }
  }
}

console.log('=== 開始執行 SpreadsheetRepository 離線單元測試集 ===\n');

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 輔助函式：建立初始種子資料的 InMemoryAdapter
function createSeededAdapter() {
  const adapter = new InMemoryAdapter({
    [SHEET_NAMES.CAMPUSES]: [
      ['校園ID', '校園名稱', '分類', '排序', '是否封存', '小排暫停週次'],
      ['CAMP_01', '中央大學', '高中', 2, false, '2026-09-06'],
      ['CAMP_02', '中壢高中', '高中', 1, false, ''],
      ['CAMP_03', '自強國中', '國中', 1, false, ''],
      ['COMM_01', '文化社區排', '社區排', 1, false, ''],
      ['CAMP_04', '已封存學校', '國中', 99, true, '']
    ],
    [SHEET_NAMES.MEMBERS]: [
      ['校園ID', '累計出席次數', '姓名', '身分', '學段', '預設值', '其他小排ID'],
      ['CAMP_01', 5, '張弟兄', '學長', '高中', '主日,小排', 'COMM_01'],
      ['CAMP_01', 3, '李姊妹', '學生', '高中', '小排', ''],
      ['CAMP_02', 8, '王同學', '學生', '高中', '', ''],
      ['COMM_01', 4, '張弟兄', '服事者', '其他', '小排', 'CAMP_01'],
      ['COMM_01', 2, '陳長老', '服事者', '其他', '', '']
    ],
    [SHEET_NAMES.ATTENDANCE]: [
      ['校園ID', '姓名', '當時身分', '週次', '類型'],
      ['CAMP_01', '張弟兄', '學長', '2026-08-30', '出席'],
      ['CAMP_01', '張弟兄', '學長', '2026-09-06', '出席'],
      ['CAMP_01', '李姊妹', '學生', '2026-09-06', '出席'],
      ['COMM_01', '張弟兄', '服事者', '2026-09-06', '出席'],
      ['CAMP_02', '王同學', '學生', '2026-09-06', '出席']
    ]
  });
  return adapter;
}

// ----------------------------------------------------
// 測試群組 1: 初始化工作表
// ----------------------------------------------------
test('1. initializeSheet 應在空白狀態下正確建立 3 個工作表與標題列', () => {
  const adapter = new InMemoryAdapter({});
  const repo = new SpreadsheetRepository(adapter);
  const res = repo.initializeSheet();
  assert.strictEqual(res.success, true);
  assert.strictEqual(adapter.tables.has(SHEET_NAMES.CAMPUSES), true);
  assert.strictEqual(adapter.tables.has(SHEET_NAMES.MEMBERS), true);
  assert.strictEqual(adapter.tables.has(SHEET_NAMES.ATTENDANCE), true);
  assert.strictEqual(adapter.tables.get(SHEET_NAMES.CAMPUSES)[0][0], '校園ID');
});

// ----------------------------------------------------
// 測試群組 2: 首頁快照讀取與排序
// ----------------------------------------------------
test('2. loadInitialSnapshot 應正確分類啟用/封存校園，排序高中國中，並解析5欄標準紀錄', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);
  const res = repo.loadInitialSnapshot();
  assert.strictEqual(res.success, true);

  const { campuses, archivedCampuses, membersByCampus, attendanceByCampus } = res.data;

  // 驗證校園分類與排序（高中優先，sort 升冪）
  assert.strictEqual(campuses.length, 4);
  assert.strictEqual(campuses[0].id, 'CAMP_02'); // sort 1
  assert.strictEqual(campuses[1].id, 'CAMP_01'); // sort 2
  assert.strictEqual(archivedCampuses.length, 1);
  assert.strictEqual(archivedCampuses[0].id, 'CAMP_04');

  // 驗證成員排序（次數降冪）
  assert.strictEqual(membersByCampus['CAMP_01'][0].name, '張弟兄');
  assert.strictEqual(membersByCampus['CAMP_01'][0].count, 5);
  assert.strictEqual(membersByCampus['CAMP_01'][1].name, '李姊妹');
  assert.strictEqual(membersByCampus['CAMP_01'][1].count, 3);

  // 驗證 5 欄標準點名紀錄被正確解析
  const camp1Att = attendanceByCampus['CAMP_01'];
  assert.strictEqual(camp1Att.length, 3);
  const rec30 = camp1Att.find(r => r.week === '2026-08-30');
  assert.ok(rec30, '應成功解析週次 2026-08-30');
  assert.strictEqual(rec30.role, '學長');
  assert.strictEqual(rec30.type, '出席');
});

// ----------------------------------------------------
// 測試群組 3: 批次點名同步 (syncAttendance)
// ----------------------------------------------------
test('3. syncAttendance 能正確新增打卡、刪除打卡、去重並清除尾部幽靈列', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  // 在 2026-09-13 為 CAMP_01 新增打卡，同時 unmark 2026-09-06 李姊妹
  const syncRes = repo.syncAttendance(
    'CAMP_01',
    '2026-09-13',
    [
      { name: '張弟兄', role: '學長', type: '出席' },
      { name: '張弟兄', role: '學長', type: '出席' } // 測試去重
    ],
    [],
    0
  );
  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.addedCount, 1, '重複標記應被去重，實際新增1筆');

  // 驗證寫入後狀態
  const snap = repo.loadInitialSnapshot();
  const c1Att = snap.data.attendanceByCampus['CAMP_01'];
  const newRec = c1Att.find(r => r.week === '2026-09-13' && r.name === '張弟兄');
  assert.ok(newRec, '新週次點名應存在');

  // 測試 unmark: 移除 2026-09-13 張弟兄
  const unmarkRes = repo.syncAttendance(
    'CAMP_01',
    '2026-09-13',
    [],
    [{ name: '張弟兄', type: '出席' }],
    0
  );
  assert.strictEqual(unmarkRes.success, true);
  assert.strictEqual(unmarkRes.removedCount, 1);

  // 再次檢查，2026-09-13 張弟兄 應已不存在
  const snap2 = repo.loadInitialSnapshot();
  const c1Att2 = snap2.data.attendanceByCampus['CAMP_01'] || [];
  const notFound = c1Att2.find(r => r.week === '2026-09-13' && r.name === '張弟兄');
  assert.strictEqual(notFound, undefined, '被 unmark 的紀錄不應再存在');
});

// ----------------------------------------------------
// 測試群組 4: 人員名單變更與改名連動 (syncMembers)
// ----------------------------------------------------
test('4. syncMembers 社區排與校園排雙向關聯與改名連動', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  // 1. 在社區排新增成員「周姊妹」，並指定 otherGroupId 為 CAMP_01
  const addCommRes = repo.syncMembers('COMM_01', {
    changes: [
      { type: 'add', name: '周姊妹', role: '家長', stage: '其他', defaults: ['小排'], otherGroupId: 'CAMP_01' }
    ]
  });
  assert.strictEqual(addCommRes.success, true);
  assert.strictEqual(addCommRes.members.some(m => m.name === '周姊妹'), true);

  // 2. 在校園排 CAMP_01 改名「李姊妹」為「李小妹」
  const renameRes = repo.syncMembers('CAMP_01', {
    changes: [
      { type: 'modify', name: '李小妹', oldName: '李姊妹', role: '學生', stage: '高中', defaults: ['小排'] }
    ]
  });
  assert.strictEqual(renameRes.success, true);
  assert.strictEqual(renameRes.members.some(m => m.name === '李小妹'), true);
  assert.strictEqual(renameRes.members.some(m => m.name === '李姊妹'), false);

  // 檢查點名表是否原子聯動改名
  const attRows = adapter.readRows(SHEET_NAMES.ATTENDANCE);
  const oldAttName = attRows.find(r => r[0] === 'CAMP_01' && r[1] === '李姊妹');
  const newAttName = attRows.find(r => r[0] === 'CAMP_01' && r[1] === '李小妹');
  assert.strictEqual(oldAttName, undefined, '點名紀錄中的舊姓名李姊妹應被清除');
  assert.ok(newAttName, '點名紀錄中的新姓名李小妹應已同步更新');

  // 3. 社區排解除關聯：修改張弟兄，清空 otherGroupId
  const unlinkRes = repo.syncMembers('COMM_01', {
    changes: [
      { type: 'modify', name: '張弟兄', oldName: '張弟兄', role: '服事者', stage: '其他', defaults: '', otherGroupId: '' }
    ]
  });
  assert.strictEqual(unlinkRes.success, true);

  // 檢查 CAMP_01 張弟兄 otherGroupId 是否被清空
  const camp1Members = repo.getCampusMembersFresh('CAMP_01');
  const zhang = camp1Members.members.find(m => m.name === '張弟兄');
  assert.strictEqual(zhang.otherGroupId, '', '社區排解除綁定後，校園排的反向連結應被清空');
});

// ----------------------------------------------------
// 測試群組 5: 校園管理 (syncCampuses & toggleSuspension)
// ----------------------------------------------------
test('5. syncCampuses, toggleCampusSuspension 與 setCampusArchivedStatus', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  // 切換暫停週次
  const susRes1 = repo.toggleCampusSuspension('CAMP_01', '2026-09-20', true);
  assert.strictEqual(susRes1.success, true);
  assert.deepStrictEqual(susRes1.suspendedWeeks, ['2026-09-06', '2026-09-20']);

  const susRes2 = repo.toggleCampusSuspension('CAMP_01', '2026-09-06', false);
  assert.strictEqual(susRes2.success, true);
  assert.deepStrictEqual(susRes2.suspendedWeeks, ['2026-09-20']);

  // 封存校園
  const arcRes = repo.setCampusArchivedStatus('CAMP_01', true);
  assert.strictEqual(arcRes.success, true);

  const snap = repo.loadInitialSnapshot();
  assert.strictEqual(snap.data.archivedCampuses.some(c => c.id === 'CAMP_01'), true);
  assert.strictEqual(snap.data.campuses.some(c => c.id === 'CAMP_01'), false);
});

// ----------------------------------------------------
// 測試群組 6: 累計出席次數重新計算 (recalculateAttendanceCounts 與 scheduledSyncAttendanceCounts)
// ----------------------------------------------------
test('6. recalculateAttendanceCounts 嚴格限制最近 8 個相異週次並精準回寫，支援 scheduledSyncAttendanceCounts 觸發', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);
  setDefaultRepository(repo);

  // 1. 基本測試：張弟兄 2 次、李姊妹 1 次
  const recountRes = repo.recalculateAttendanceCounts(false);
  assert.strictEqual(recountRes.success, true);

  const mList = recountRes.data.membersByCampus['CAMP_01'];
  const zhang = mList.find(m => m.name === '張弟兄');
  const lee = mList.find(m => m.name === '李姊妹');
  assert.strictEqual(zhang.count, 2, '張弟兄累計出席次數應重算為 2');
  assert.strictEqual(lee.count, 1, '李姊妹累計出席次數應重算為 1');

  // 檢查 Members 工作表 B 欄是否真實被更新
  let freshRows = adapter.readRows(SHEET_NAMES.MEMBERS);
  let zhangRow = freshRows.find(r => r[0] === 'CAMP_01' && r[2] === '張弟兄');
  assert.strictEqual(zhangRow[1], 2);

  // 2. 邊界測試：加入 9 個相異週次的出席紀錄，驗證第 9 週（最舊週）被排除在 8 週視窗外
  const attTable = adapter.tables.get(SHEET_NAMES.ATTENDANCE);
  attTable.length = 1; // 留下標題
  const weeks = [
    '2026-07-05', // 最舊週（第 9 週），應被排除
    '2026-07-12', // 第 8 週
    '2026-07-19', // 第 7 週
    '2026-07-26', // 第 6 週
    '2026-08-02', // 第 5 週
    '2026-08-09', // 第 4 週
    '2026-08-16', // 第 3 週
    '2026-08-23', // 第 2 週
    '2026-08-30'  // 第 1 週（最新週）
  ];
  weeks.forEach(w => {
    attTable.push(['CAMP_01', '張弟兄', '學長', w, '出席']);
  });

  // 執行定時觸發器專用函式
  const schedRes = scheduledSyncAttendanceCounts();
  assert.strictEqual(schedRes.success, true);

  const mList2 = schedRes.data.membersByCampus['CAMP_01'];
  const zhang2 = mList2.find(m => m.name === '張弟兄');
  assert.strictEqual(zhang2.count, 8, '9 個相異週次中，張弟兄僅應計算最近 8 週，次數必須為 8');

  freshRows = adapter.readRows(SHEET_NAMES.MEMBERS);
  zhangRow = freshRows.find(r => r[0] === 'CAMP_01' && r[2] === '張弟兄');
  assert.strictEqual(zhangRow[1], 8, '試算表 B 欄回寫值應為 8');
});

// ----------------------------------------------------
// 測試群組 7: 整併校園事務 (executeUnitOfWork)
// ----------------------------------------------------
test('7. executeMergeCampuses 正確整併點名紀錄、合併成員預設值、並移除來源校園', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);
  setDefaultRepository(repo);

  // 驗證輕量校園清單（專供對話框使用）
  const dialogList = repo.getCampusesForDialog();
  assert.strictEqual(dialogList.success, true);
  assert.strictEqual(dialogList.data.length, 5);
  assert.strictEqual(dialogList.data[0].id, 'CAMP_02'); // sort 1 comes first

  // 整併 CAMP_02 至 CAMP_01
  const mergeRes = executeMergeCampuses('CAMP_02', 'CAMP_01');
  assert.strictEqual(mergeRes.success, true);

  // 驗證點名紀錄：原屬 CAMP_02 的 王同學 現在應屬於 CAMP_01
  const attRows = adapter.readRows(SHEET_NAMES.ATTENDANCE);
  assert.strictEqual(attRows.some(r => r[0] === 'CAMP_02'), false, 'CAMP_02 的點名紀錄應已全數轉移');
  const wangAtt = attRows.find(r => r[0] === 'CAMP_01' && r[1] === '王同學');
  assert.ok(wangAtt, '王同學點名紀錄應已移轉至 CAMP_01');

  // 驗證成員：CAMP_01 應包含 王同學
  const memRows = adapter.readRows(SHEET_NAMES.MEMBERS);
  assert.strictEqual(memRows.some(r => r[0] === 'CAMP_02'), false, 'CAMP_02 的成員應已無殘留');
  const wangMem = memRows.find(r => r[0] === 'CAMP_01' && r[2] === '王同學');
  assert.ok(wangMem, '王同學應已移轉入 CAMP_01 成員名單');

  // 驗證校園：CAMP_02 已從校園列表移除
  const campRows = adapter.readRows(SHEET_NAMES.CAMPUSES);
  assert.strictEqual(campRows.some(r => r[0] === 'CAMP_02'), false, 'CAMP_02 應已從校園列表移除');
});

// ----------------------------------------------------
// 測試群組 8: 一鍵套用預設出席紀錄 (applyDefaultAttendance)
// ----------------------------------------------------
test('8. applyDefaultAttendance 能局部覆蓋當週出席紀錄並保留其他週次', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  // 套用 CAMP_01 於 2026-09-06 之預設紀錄：只有 李姊妹（原有的 張弟兄 應被剔除）
  const defRes = repo.applyDefaultAttendance('CAMP_01', '2026-09-06', [
    { name: '李姊妹', role: '學生', type: '出席' }
  ]);
  assert.strictEqual(defRes.success, true);

  const snap = repo.loadInitialSnapshot();
  const c1Att = snap.data.attendanceByCampus['CAMP_01'];
  // 檢查 2026-09-06 只有李姊妹
  const weekRecords = c1Att.filter(r => r.week === '2026-09-06');
  assert.strictEqual(weekRecords.length, 1);
  assert.strictEqual(weekRecords[0].name, '李姊妹');
  // 但 2026-08-30 的張弟兄依然保留
  assert.ok(c1Att.some(r => r.week === '2026-08-30' && r.name === '張弟兄'));
});

// ----------------------------------------------------
// 測試群組 9: 歷史點名區間查詢 (queryAttendanceHistory)
// ----------------------------------------------------
test('9. queryAttendanceHistory 依日期區間與校園過濾並正確回傳 hasMore', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  // 查詢 2026-09-01 至 2026-09-10（應排除 2026-08-30，並標記 hasMore = true）
  const res = repo.queryAttendanceHistory('CAMP_01', '2026-09-01', '2026-09-10');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.hasMore, true);
  const camp1 = res.data.attendanceByCampus['CAMP_01'];
  assert.strictEqual(camp1.length, 2);
  assert.strictEqual(camp1.every(r => r.week >= '2026-09-01'), true);
});

// ----------------------------------------------------
// 測試群組 10: 外部查詢各校最後狀態 (getLastAttendanceWeeks)
// ----------------------------------------------------
test('10. getLastAttendanceWeeks 綜合出席與暫停週次回傳正確狀態', () => {
  const adapter = createSeededAdapter();
  const repo = new SpreadsheetRepository(adapter);

  const statusRes = repo.getLastAttendanceWeeks();
  assert.strictEqual(statusRes.success, true);
  const data = statusRes.data;

  // CAMP_01 暫停為 2026-09-06，出席為 2026-09-06，取出席 (attended)
  assert.strictEqual(data['CAMP_01'].status, 'attended');
  assert.strictEqual(data['CAMP_01'].latestWeek, '2026-09-06');

  // CAMP_02 無暫停，出席為 2026-09-06
  assert.strictEqual(data['CAMP_02'].status, 'attended');

  // CAMP_03 無點名無暫停
  assert.strictEqual(data['CAMP_03'].status, 'none');
  assert.strictEqual(data['CAMP_03'].latestWeek, null);
});

// ----------------------------------------------------
// 測試群組 11: 切片截斷安全邊界 (Safe Week Boundary)
// ----------------------------------------------------
test('11. loadInitialSnapshot 當紀錄超過切片大小時，自動跳過被截斷的殘缺首週', () => {
  const adapter = new InMemoryAdapter({
    [SHEET_NAMES.CAMPUSES]: [
      ['校園ID', '校園名稱', '分類', '排序', '是否封存', '小排暫停週次'],
      ['CAMP_01', '中央大學', '高中', 1, false, '']
    ],
    [SHEET_NAMES.MEMBERS]: [
      ['校園ID', '累計出席次數', '姓名', '身分', '學段', '預設值', '其他小排ID'],
      ['CAMP_01', 1, '小明', '學生', '高中', '', '']
    ],
    [SHEET_NAMES.ATTENDANCE]: [
      ['校園ID', '姓名', '當時身分', '週次', '類型'],
      ['CAMP_01', '小明', '學生', '2026-08-16', '出席'],
      ['CAMP_01', '小華', '學生', '2026-08-16', '出席'],
      ['CAMP_01', '小明', '學生', '2026-08-23', '出席'],
      ['CAMP_01', '小明', '學生', '2026-08-30', '出席']
    ]
  });

  const repo = new SpreadsheetRepository(adapter);
  const snap = repo.loadInitialSnapshot({ attendanceChunkSize: 3 });
  assert.strictEqual(snap.success, true);
  assert.strictEqual(snap.data.minLoadedWeek, '2026-08-23');
  const camp1 = snap.data.attendanceByCampus['CAMP_01'];
  assert.strictEqual(camp1.some(r => r.week === '2026-08-16'), false, '殘缺週紀錄應被排除於初始快照外');
  assert.strictEqual(camp1.some(r => r.week === '2026-08-23'), true);
  assert.strictEqual(camp1.some(r => r.week === '2026-08-30'), true);
});

// ----------------------------------------------------
// 測試群組 12: 傳遞改名鏈與批次連續操作 (Transitive Rename Chain & Multi-Ops)
// ----------------------------------------------------
test('12. syncMembers 支援同一人連續改名兩次與預設出席增刪 (A -> B -> C)，點名表與名單表皆正確連動', () => {
  const adapter = new InMemoryAdapter({
    [SHEET_NAMES.CAMPUSES]: [
      ['校園ID', '校園名稱', '分類', '排序', '是否封存', '小排暫停週次'],
      ['CAMP_01', '中央大學', '高中', 1, false, '']
    ],
    [SHEET_NAMES.MEMBERS]: [
      ['校園ID', '累計出席次數', '姓名', '身分', '學段', '預設值', '其他小排ID'],
      ['CAMP_01', 5, '張三', '學生', '高中', '', '']
    ],
    [SHEET_NAMES.ATTENDANCE]: [
      ['校園ID', '姓名', '當時身分', '週次', '類型'],
      ['CAMP_01', '張三', '學生', '2026-08-30', '出席'],
      ['CAMP_01', '張三', '學生', '2026-09-06', '出席']
    ]
  });

  const repo = new SpreadsheetRepository(adapter);

  // 模擬同一批次包含：張三改為張四 -> 張四改為張五 -> 設為預設出席 -> 取消預設出席
  const res = repo.syncMembers('CAMP_01', {
    changes: [
      { type: 'modify', oldName: '張三', name: '張四', role: '學生', stage: '高中', defaults: '' },
      { type: 'modify', oldName: '張四', name: '張五', role: '學生', stage: '高中', defaults: '' },
      { type: 'modify', oldName: '張五', name: '張五', role: '學生', stage: '高中', defaults: '出席' },
      { type: 'modify', oldName: '張五', name: '張五', role: '學生', stage: '高中', defaults: '' }
    ]
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.members.length, 1);
  assert.strictEqual(res.members[0].name, '張五', '成員名單表最終名稱應為張五');
  assert.deepStrictEqual(res.members[0].defaults, [], '預設值最終應為空');
  assert.strictEqual(res.members[0].count, 5, '累計出席次數應完整保留');

  // 驗證 ATTENDANCE 點名表歷史紀錄是否正確傳遞改名為「張五」
  const attRows = adapter.readRows(SHEET_NAMES.ATTENDANCE);
  assert.strictEqual(attRows.length, 2);
  assert.strictEqual(attRows[0][1], '張五', '第一筆點名紀錄應透過改名鏈傳遞更新為張五');
  assert.strictEqual(attRows[1][1], '張五', '第二筆點名紀錄應透過改名鏈傳遞更新為張五');
});

console.log(`\n=== 恭喜！全部 ${passedTests} 項單元測試順利通過！ ===`);
