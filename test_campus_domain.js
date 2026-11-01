/**
 * test_campus_domain.js
 * 
 * 測試項目：
 * 1. CampusDomain 領域規則方法 (getCat, isSchool, isCommunity) 及其各種輸入型別與邊界防護
 * 2. backup.gs 的 GoogleSheetAdapter.withLock 在 LockService.tryLock 失敗時正確回傳友善錯誤物件
 * 3. generateAllSemesterReports 在鎖爭用時正確回傳友善錯誤
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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

console.log('=== 開始測試 CampusDomain 領域規則與 LockService 友善提示 ===\n');

// 載入 core.js 的 CampusDomain（清理 GAS 範本標籤）
const rawCoreCode = fs.readFileSync(__dirname + '/src/js/core.js', 'utf8');
const coreCode = rawCoreCode.replace(/<\?!=[\s\S]*?\?>/g, 'null');
const coreCtx = {
  document: { getElementById: () => null },
  window: { matchMedia: () => ({ matches: false }) },
  AttendanceStore: function() {},
  MemberStore: function() {},
  CampusStore: function() {},
  module: { exports: {} }
};
vm.createContext(coreCtx);
vm.runInContext(coreCode, coreCtx);
const CampusDomain = coreCtx.CampusDomain || coreCtx.module.exports.CampusDomain;

assert(CampusDomain, 'CampusDomain 應正確定義');

// 1. 測試 CampusDomain.getCat
test('1. CampusDomain.getCat 正常解析字串與物件', () => {
  assert.strictEqual(CampusDomain.getCat('高中'), '高中');
  assert.strictEqual(CampusDomain.getCat('國中'), '國中');
  assert.strictEqual(CampusDomain.getCat('社區排'), '社區排');
  assert.strictEqual(CampusDomain.getCat({ category: '高中' }), '高中');
  assert.strictEqual(CampusDomain.getCat({ id: 'CAMP_1', name: '台南一中', category: '高中' }), '高中');
  assert.strictEqual(CampusDomain.getCat({ id: 'COMM_1', name: '東區社區', category: '社區排' }), '社區排');
});

test('2. CampusDomain.getCat 防護邊界值 (null, undefined, 空物件, 空字串)', () => {
  assert.strictEqual(CampusDomain.getCat(null), '');
  assert.strictEqual(CampusDomain.getCat(undefined), '');
  assert.strictEqual(CampusDomain.getCat(''), '');
  assert.strictEqual(CampusDomain.getCat({}), '');
  assert.strictEqual(CampusDomain.getCat({ name: '無分類校園' }), '');
});

// 2. 測試 CampusDomain.isSchool
test('3. CampusDomain.isSchool 正確判斷國中與高中 (字串或物件皆支援)', () => {
  assert.strictEqual(CampusDomain.isSchool('高中'), true);
  assert.strictEqual(CampusDomain.isSchool('國中'), true);
  assert.strictEqual(CampusDomain.isSchool({ category: '高中' }), true);
  assert.strictEqual(CampusDomain.isSchool({ category: '國中' }), true);
  assert.strictEqual(CampusDomain.isSchool({ id: 'C1', category: '高中' }), true);

  assert.strictEqual(CampusDomain.isSchool('社區排'), false);
  assert.strictEqual(CampusDomain.isSchool({ category: '社區排' }), false);
  assert.strictEqual(CampusDomain.isSchool('其他'), false);
  assert.strictEqual(CampusDomain.isSchool(null), false);
  assert.strictEqual(CampusDomain.isSchool(undefined), false);
  assert.strictEqual(CampusDomain.isSchool({}), false);
});

// 3. 測試 CampusDomain.isCommunity
test('4. CampusDomain.isCommunity 正確判斷社區排 (字串或物件皆支援)', () => {
  assert.strictEqual(CampusDomain.isCommunity('社區排'), true);
  assert.strictEqual(CampusDomain.isCommunity({ category: '社區排' }), true);
  assert.strictEqual(CampusDomain.isCommunity({ id: 'COMM_1', category: '社區排' }), true);

  assert.strictEqual(CampusDomain.isCommunity('高中'), false);
  assert.strictEqual(CampusDomain.isCommunity('國中'), false);
  assert.strictEqual(CampusDomain.isCommunity({ category: '高中' }), false);
  assert.strictEqual(CampusDomain.isCommunity(null), false);
  assert.strictEqual(CampusDomain.isCommunity(undefined), false);
  assert.strictEqual(CampusDomain.isCommunity(''), false);
});

// 4. 測試 backup.gs 中的 CampusDomain 與 GoogleSheetAdapter.withLock
test('5. backup.gs 中的 CampusDomain 與 core.js 保持完全一致之行為', () => {
  const gasCode = fs.readFileSync(__dirname + '/backup.gs', 'utf8');
  vm.runInThisContext(gasCode);

  assert(typeof CampusDomain !== 'undefined', 'backup.gs 應定義 CampusDomain');
  assert.strictEqual(CampusDomain.isCommunity('社區排'), true);
  assert.strictEqual(CampusDomain.isCommunity({ category: '社區排' }), true);
  assert.strictEqual(CampusDomain.isSchool('高中'), true);
  assert.strictEqual(CampusDomain.isSchool('國中'), true);
  assert.strictEqual(CampusDomain.isSchool('社區排'), false);
  assert.strictEqual(CampusDomain.getCat({ category: '國中' }), '國中');
});

test('6. GoogleSheetAdapter.withLock 在 lock.tryLock 超時時回傳友善錯誤物件', () => {
  let lockAcquired = false;
  let releaseCalled = false;

  const mockLock = {
    tryLock: (timeoutMs) => {
      assert.strictEqual(timeoutMs, 5000);
      return false; // 模擬搶鎖失敗/超時
    },
    releaseLock: () => {
      releaseCalled = true;
    }
  };

  global.LockService = {
    getScriptLock: () => mockLock
  };

  const adapter = new GoogleSheetAdapter();
  let actionExecuted = false;
  const result = adapter.withLock(5000, () => {
    actionExecuted = true;
    return { success: true };
  });

  assert.strictEqual(actionExecuted, false, '搶鎖失敗時 action 絕不應被執行');
  assert.strictEqual(releaseCalled, false, '未獲取鎖時不應釋放鎖');
  assert.deepStrictEqual(result, {
    success: false,
    error: '系統目前繁忙（其他使用者正在同步資料），請稍候片刻再試'
  });
});

test('7. GoogleSheetAdapter.withLock 成功獲取鎖時執行 action 並正確釋放鎖', () => {
  let releaseCalled = false;
  const mockLock = {
    tryLock: (timeoutMs) => {
      assert.strictEqual(timeoutMs, 10000);
      return true; // 成功取得鎖
    },
    releaseLock: () => {
      releaseCalled = true;
    }
  };

  global.LockService = {
    getScriptLock: () => mockLock
  };

  const adapter = new GoogleSheetAdapter();
  let actionExecuted = false;
  const result = adapter.withLock(10000, () => {
    actionExecuted = true;
    return { success: true, data: 'test_ok' };
  });

  assert.strictEqual(actionExecuted, true);
  assert.strictEqual(releaseCalled, true, '成功取得鎖後必須在 finally 釋放鎖');
  assert.deepStrictEqual(result, { success: true, data: 'test_ok' });
});

test('8. generateAllSemesterReports 在鎖爭用時直接回傳友善錯誤物件', () => {
  const mockLock = {
    tryLock: () => false, // 模擬報表鎖爭用
    releaseLock: () => {}
  };

  global.LockService = {
    getScriptLock: () => mockLock
  };
  global.SpreadsheetApp = {
    getUi: () => ({ alert: () => {} })
  };

  const result = generateAllSemesterReports(false);
  assert.deepStrictEqual(result, {
    success: false,
    error: '系統目前繁忙（其他使用者正在同步資料），請稍候片刻再試'
  });
});

console.log(`\n=== 恭喜！全部 ${passedTests} 項單元測試順利通過！ ===\n`);
