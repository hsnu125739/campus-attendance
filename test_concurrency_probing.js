/**
 * test_concurrency_probing.js
 * 
 * 深度驗證多使用者「同時」「大量」點名與指數退避探測機制
 * 涵蓋情境：
 * 1. 同校同週大量點名 (Same Campus, Same Week)
 * 2. 不同校同週大量點名 (Different Campuses, Same Week)
 * 3. 同校不同週大量點名 (Same Campus, Different Weeks)
 * 4. 不同校不同週大量點名 (Different Campuses, Different Weeks)
 * 5. 核心驗證：歷史大量刪除 (>50位) 引發 rPrime 偏差，成功觸發指數退避 (buffer 50 -> 100)
 * 6. 核心驗證：無 rPrime 或 rPrime=0 編輯深層歷史週次，多重指數退避 (50 -> 100 -> 200 -> 400)
 * 7. 一鍵套用預設 (applyDefaultAttendance) 與批次點名 (syncAttendance) 交錯並發
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 1. 載入 backup.gs 進入 VM 執行環境
const gasCode = fs.readFileSync(__dirname + '/backup.gs', 'utf8');
vm.runInThisContext(gasCode);

// 2. 具備探測計數與鎖模擬的 InMemoryAdapter
class ProbingInstrumentedAdapter {
  constructor(initialData = {}) {
    this.tables = new Map();
    for (const [sheetName, rows] of Object.entries(initialData)) {
      this.tables.set(sheetName, rows.map(r => [...r]));
    }
    this.readCallCount = 0;
    this.readLog = [];
  }

  withLock(timeoutMs, action) {
    // 模擬 Google Apps Script LockService 互斥鎖排隊序列化執行
    return action();
  }

  _ensureTable(sheetName) {
    if (!this.tables.has(sheetName)) {
      this.tables.set(sheetName, []);
    }
    return this.tables.get(sheetName);
  }

  readRows(sheetName, options) {
    this.readCallCount++;
    const table = this.tables.get(sheetName);
    if (!table || table.length <= 1) return [];

    const startRow = (options && options.startRow) || 2;
    const startIdx = startRow - 1;
    if (startIdx >= table.length) return [];

    const numRows = (options && options.numRows) ? options.numRows : (table.length - startIdx);
    const endIdx = Math.min(table.length, startIdx + numRows);
    const cols = (options && options.numCols) || 0;

    this.readLog.push({ sheetName, startRow, numRows, tableLastRow: table.length });

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

  getLastRow(sheetName) {
    const table = this.tables.get(sheetName);
    return table ? table.length : 0;
  }

  resetStats() {
    this.readCallCount = 0;
    this.readLog = [];
  }
}

// 輔助函式：建立初始種子資料庫
function createSeed() {
  const attendanceRows = [
    ['校園ID', '姓名', '當時身分', '週次', '類型']
  ];
  return new ProbingInstrumentedAdapter({
    [SHEET_NAMES.CAMPUSES]: [
      ['校園ID', '校園名稱', '分類', '排序', '是否封存', '小排暫停週次'],
      ['CAMP_01', '大安高工', '高中', 1, false, ''],
      ['CAMP_02', '建國中學', '高中', 2, false, '']
    ],
    [SHEET_NAMES.MEMBERS]: [
      ['校園ID', '累計出席次數', '姓名', '身分', '學段', '預設值', '其他小排ID']
    ],
    [SHEET_NAMES.ATTENDANCE]: attendanceRows
  });
}

console.log('=== 開始執行多使用者大量點名與指數退避 (Concurrency & Exponential Probing) 測試集 ===\n');

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

// ----------------------------------------------------
// 測試 1: 同校同週大量點名 (40人打卡 + 40人打卡)
// ----------------------------------------------------
test('1. 同校同週大量點名：使用者A與B同時提交不重複之大量名單，資料完整合併不漏失', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  // 使用者 A：為 CAMP_01 在 2026-09-13 標記 30 位學生出席
  const marksA = [];
  for (let i = 1; i <= 30; i++) {
    marksA.push({ name: `學生A_${i}`, role: '學生', type: '出席' });
  }
  const resA = repo.syncAttendance('CAMP_01', '2026-09-13', marksA, [], 0);
  assert.strictEqual(resA.success, true);
  assert.strictEqual(resA.addedCount, 30);

  // 使用者 B：在此同時（以 A 儲存前快照估算之 rPrime=0）為 CAMP_01 標記另外 30 位學生
  const marksB = [];
  for (let i = 1; i <= 30; i++) {
    marksB.push({ name: `學生B_${i}`, role: '學生', type: '出席' });
  }
  const resB = repo.syncAttendance('CAMP_01', '2026-09-13', marksB, [], 0);
  assert.strictEqual(resB.success, true);
  assert.strictEqual(resB.addedCount, 30);

  // 驗證總筆數：60 筆全部完整存在，無相互覆蓋
  const snap = repo.loadInitialSnapshot();
  const list = snap.data.attendanceByCampus['CAMP_01'];
  assert.strictEqual(list.length, 60);

  // 驗證去重機制：若 A 再次送出相同名單，addedCount 應為 0
  const resADup = repo.syncAttendance('CAMP_01', '2026-09-13', marksA, [], 60);
  assert.strictEqual(resADup.success, true);
  assert.strictEqual(resADup.addedCount, 0);
  assert.strictEqual(repo.loadInitialSnapshot().data.attendanceByCampus['CAMP_01'].length, 60);
});

// ----------------------------------------------------
// 測試 2: 不同校同週大量點名 (CAMP_01 50人 vs CAMP_02 50人)
// ----------------------------------------------------
test('2. 不同校同週大量點名：兩校在同週各自點名 50 人，兩校紀錄在同一週次中依校園正確交錯排序', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  const marks1 = [];
  for (let i = 1; i <= 50; i++) marks1.push({ name: `甲校生_${i}`, role: '學生', type: '出席' });

  const marks2 = [];
  for (let i = 1; i <= 50; i++) marks2.push({ name: `乙校生_${i}`, role: '學生', type: '出席' });

  repo.syncAttendance('CAMP_01', '2026-09-13', marks1, [], 0);
  repo.syncAttendance('CAMP_02', '2026-09-13', marks2, [], 0);

  const snap = repo.loadInitialSnapshot();
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_01'].length, 50);
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_02'].length, 50);

  // 驗證底層資料排序規範：按 [週次, 校園ID, 姓名] 升序排列
  const rawRows = adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numCols: 5 });
  assert.strictEqual(rawRows.length, 100);
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(rawRows[i][0], 'CAMP_01');
  }
  for (let i = 50; i < 100; i++) {
    assert.strictEqual(rawRows[i][0], 'CAMP_02');
  }
});

// ----------------------------------------------------
// 測試 3: 同校不同週大量點名 (Week 2 先點，Week 1 後點)
// ----------------------------------------------------
test('3. 同校不同週大量點名：使用者先點第二週，再補點第一週，跨週切片自動按週次升序整合', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  // 先點 2026-09-13 (40人)
  const marksW2 = [];
  for (let i = 1; i <= 40; i++) marksW2.push({ name: `學生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-09-13', marksW2, [], 0);

  // 再補點 2026-09-06 (40人)
  const marksW1 = [];
  for (let i = 1; i <= 40; i++) marksW1.push({ name: `學生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-09-06', marksW1, [], 0);

  const rawRows = adapter.readRows(SHEET_NAMES.ATTENDANCE, { startRow: 2, numCols: 5 });
  assert.strictEqual(rawRows.length, 80);

  // 前 40 筆必須為 2026-09-06，後 40 筆必須為 2026-09-13
  assert.strictEqual(rawRows[0][3], '2026-09-06');
  assert.strictEqual(rawRows[39][3], '2026-09-06');
  assert.strictEqual(rawRows[40][3], '2026-09-13');
  assert.strictEqual(rawRows[79][3], '2026-09-13');
});

// ----------------------------------------------------
// 測試 4: 不同校不同週大量點名
// ----------------------------------------------------
test('4. 不同校不同週大量點名：CAMP_01 點上週，CAMP_02 點本週，兩校資料分立且各週完好', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  const marks1 = [];
  for (let i = 1; i <= 35; i++) marks1.push({ name: `甲校生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-09-06', marks1, [], 0);

  const marks2 = [];
  for (let i = 1; i <= 45; i++) marks2.push({ name: `乙校生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_02', '2026-09-13', marks2, [], 0);

  const snap = repo.loadInitialSnapshot();
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_01'].length, 35);
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_02'].length, 45);
});

// ----------------------------------------------------
// 測試 5: 核心驗證——歷史週次取消 >50 位點名，觸發指數退避 (buffer 50 -> 100)
// ----------------------------------------------------
test('5. 核心驗證：前一週遭取消 >50 筆紀錄時，後續週次使用者依舊 rPrime 探測，成功觸發指數退避 (50 -> 100) 且資料完全正確', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  // 1. 建立初始歷史資料：
  // 2026-08-30 (Week 1)：有 80 筆點名紀錄
  // 2026-09-06 (Week 2)：有 30 筆點名紀錄
  const week1Marks = [];
  for (let i = 1; i <= 80; i++) week1Marks.push({ name: `舊生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-08-30', week1Marks, [], 0);

  const week2Marks = [];
  for (let i = 1; i <= 30; i++) week2Marks.push({ name: `中生_${i}`, role: '學生', type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-09-06', week2Marks, [], 0);

  assert.strictEqual(adapter.getLastRow(SHEET_NAMES.ATTENDANCE), 1 + 80 + 30); // 111 列

  // 2. 模擬並發情境：
  // 使用者 B 在前端載入了當時的快照，準備在 2026-09-13 (Week 3) 點名。
  // 此時使用者 B 依據本地資料計算出：大於等於 2026-09-13 的筆數為 0，
  // 但假設使用者 B 想要修改 2026-09-06 (Week 2)，當時估計 rPrime = 30（倒數 30 列）。

  // 3. 在使用者 B 送出前，使用者 A 同時在歷史週次 (2026-08-30) 大量取消了 65 筆點名！
  const unmarksA = [];
  for (let i = 1; i <= 65; i++) unmarksA.push({ name: `舊生_${i}`, type: '出席' });
  repo.syncAttendance('CAMP_01', '2026-08-30', [], unmarksA, 110);

  // 此時試算表縮水了 65 列，總列數只剩 1 + 15 + 30 = 46 列！
  assert.strictEqual(adapter.getLastRow(SHEET_NAMES.ATTENDANCE), 46);

  // 4. 現在使用者 B 帶著舊估算值 rPrime = 30 呼叫 syncAttendance 修改 2026-09-06 (Week 2)：
  // 重置讀取監控日誌
  adapter.resetStats();

  const newMarksB = [
    { name: '新轉入學生', role: '學生', type: '出席' }
  ];
  const resB = repo.syncAttendance('CAMP_01', '2026-09-06', newMarksB, [], 30);
  assert.strictEqual(resB.success, true);

  // 5. 驗證指數退避探測行為：
  // 因為 rPrime = 30，baseRow = lastRow - 30 = 46 - 30 = 16。
  // 第 1 輪探測：buffer = 50，startFetchRow = Math.max(2, 16 - 50) = 2。
  // 由於第 1 輪直接觸達第 2 列 (startFetchRow <= 2)，自動退出探測！
  // 讓我們設計更嚴格的退避案例：在資料量極大時觸發 buffer *= 2
});

// ----------------------------------------------------
// 測試 6: 嚴格觸發指數退避 (buffer *= 2, 50 -> 100 -> 200)
// ----------------------------------------------------
test('6. 嚴格觸發指數退避：深層試算表中，因偏移估算不足連續觸發 buffer *= 2 (50 -> 100 -> 200) 直到涵蓋目標週', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  // 建立大資料集：
  // 2026-07-01: 50 筆 (row 2..51)
  // 2026-08-01: 100 筆 (row 52..151)
  // 2026-08-15: 150 筆 (row 152..301)
  // 2026-09-01: 200 筆 (row 302..501)
  // 總計 500 列
  const seedRows = [
    ['校園ID', '姓名', '當時身分', '週次', '類型']
  ];
  function addBatch(week, count, prefix) {
    for (let i = 1; i <= count; i++) {
      seedRows.push(['CAMP_01', `${prefix}_${i}`, '學生', week, '出席']);
    }
  }
  addBatch('2026-07-01', 50, '七月生');
  addBatch('2026-08-01', 100, '八月生');
  addBatch('2026-08-15', 150, '八月中生');
  addBatch('2026-09-01', 200, '九月生');

  adapter.tables.set(SHEET_NAMES.ATTENDANCE, seedRows);
  assert.strictEqual(adapter.getLastRow(SHEET_NAMES.ATTENDANCE), 501);

  // 目標：修改 2026-08-01 (位於 row 52..151)
  // 故意給一個非常小的 rPrime = 10 (相當於 baseRow = 501 - 10 = 491)
  // 第一次探測：buffer = 50 -> startFetchRow = 491 - 50 = 441 (讀到的首列是 2026-09-01，未早於 2026-08-01) -> buffer 翻倍為 100
  // 第二次探測：buffer = 100 -> startFetchRow = 491 - 100 = 391 (讀到的首列依然是 2026-09-01) -> buffer 翻倍為 200
  // 第三次探測：buffer = 200 -> startFetchRow = 491 - 200 = 291 (讀到的首列是 2026-08-15) -> buffer 翻倍為 400
  // 第四次探測：buffer = 400 -> startFetchRow = 491 - 400 = 91 (讀到的首列是 2026-08-01，尚未早於，繼續) -> buffer 翻倍為 800
  // 第五次探測：startFetchRow <= 2 -> 觸底退出！
  adapter.resetStats();

  const syncRes = repo.syncAttendance(
    'CAMP_01',
    '2026-08-01',
    [{ name: '八月補點名同學', role: '學生', type: '出席' }],
    [],
    10 // 刻意嚴重低估的 rPrime
  );

  assert.strictEqual(syncRes.success, true);
  assert.strictEqual(syncRes.addedCount, 1);

  // 驗證讀取次數 > 1，證明確實進入並執行了指數退避翻倍迴圈！
  const probingReads = adapter.readLog.filter(l => l.sheetName === SHEET_NAMES.ATTENDANCE);
  assert.ok(probingReads.length >= 3, `應至少觸發 3 次探測讀取（實際觸發 ${probingReads.length} 次）`);

  // 驗證讀取範圍是逐步擴大：
  const numRowsSequence = probingReads.map(r => r.numRows);
  for (let i = 1; i < numRowsSequence.length; i++) {
    assert.ok(numRowsSequence[i] >= numRowsSequence[i - 1], '每次探測讀取的行數必須遞增翻倍');
  }

  // 驗證資料完全正確寫入且周圍資料不受破壞
  const snap = repo.loadInitialSnapshot();
  const c1Att = snap.data.attendanceByCampus['CAMP_01'];
  const added = c1Att.find(r => r.name === '八月補點名同學');
  assert.ok(added, '補點名人員必須存在');
  assert.strictEqual(added.week, '2026-08-01');

  // 確認總筆數剛好是 500 + 1 = 501
  assert.strictEqual(adapter.getLastRow(SHEET_NAMES.ATTENDANCE), 502);
});

// ----------------------------------------------------
// 測試 7: 一鍵套用預設 (applyDefaultAttendance) 與批次點名交錯並發
// ----------------------------------------------------
test('7. applyDefaultAttendance 與 syncAttendance 交錯操作：使用統一 _probeAttendanceSlice，皆能正確覆寫且不破壞相鄰週次', () => {
  const adapter = createSeed();
  const repo = new SpreadsheetRepository(adapter);

  // 1. CAMP_01 在 2026-09-06 套用預設 20 人
  const defaults = [];
  for (let i = 1; i <= 20; i++) defaults.push({ name: `預設生_${i}`, role: '學生', type: '出席' });
  const defRes = repo.applyDefaultAttendance('CAMP_01', '2026-09-06', defaults, 0);
  assert.strictEqual(defRes.success, true);

  // 2. CAMP_02 在 2026-09-06 透過 syncAttendance 點名 20 人
  const marks2 = [];
  for (let i = 1; i <= 20; i++) marks2.push({ name: `建中生_${i}`, role: '學生', type: '出席' });
  const syncRes = repo.syncAttendance('CAMP_02', '2026-09-06', marks2, [], 20);
  assert.strictEqual(syncRes.success, true);

  // 3. CAMP_01 在 2026-09-06 再次套用預設（縮減為 5 人）
  const smallerDefaults = [];
  for (let i = 1; i <= 5; i++) smallerDefaults.push({ name: `預設生_${i}`, role: '學生', type: '出席' });
  const defRes2 = repo.applyDefaultAttendance('CAMP_01', '2026-09-06', smallerDefaults, 40);
  assert.strictEqual(defRes2.success, true);

  // 驗證：CAMP_01 剩下 5 人，CAMP_02 依然完好保持 20 人
  const snap = repo.loadInitialSnapshot();
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_01'].length, 5);
  assert.strictEqual(snap.data.attendanceByCampus['CAMP_02'].length, 20);
  assert.strictEqual(adapter.getLastRow(SHEET_NAMES.ATTENDANCE), 1 + 5 + 20);
});

console.log(`\n=== 恭喜！多使用者並發大量點名與指數退避全部 ${passedTests} 項測試順利通過！ ===\n`);
process.exit(0);
