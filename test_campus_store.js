/**
 * test_campus_store.js
 * 
 * 測試小排管理 CampusStore 深模組
 * 100% 脫離瀏覽器 DOM，在 Node.js 本地環境運行極速單元測試。
 */

const assert = require('assert');
const { CampusStore } = require('./src/js/campus_store.js');

console.log('=== 開始執行 CampusStore 離線單元測試集 ===\n');

let passedTests = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

(async () => {
  // 1. 快照擷取深拷貝隔離
  await test('1. captureSnapshot 應深拷貝校園狀態，修改原物件不影響快照', () => {
    const store = new CampusStore();
    const campuses = [{ id: 'CAMP_1', name: '建國中學', category: '高中', sort: 1 }];
    const archived = [{ id: 'CAMP_2', name: '成功高中', category: '高中', sort: 2 }];

    const snap = store.captureSnapshot(campuses, archived);
    campuses[0].name = '改名建中';
    assert.strictEqual(snap.campuses[0].name, '建國中學', '快照中的名稱不應受外部變更影響');
  });

  // 2. areCampusListsEqual 正確檢測相同與相異清單
  await test('2. areCampusListsEqual 能精確識別相同與相異清單', () => {
    const store = new CampusStore();
    const listA = [
      { id: 'CAMP_1', name: '師大附中', category: '高中', sort: 1 },
      { id: 'CAMP_2', name: '北一女中', category: '高中', sort: 2 }
    ];
    const listB = [
      { id: 'CAMP_1', name: '師大附中', category: '高中', sort: 1 },
      { id: 'CAMP_2', name: '北一女中', category: '高中', sort: 2 }
    ];
    const listDiffName = [
      { id: 'CAMP_1', name: '附中', category: '高中', sort: 1 },
      { id: 'CAMP_2', name: '北一女中', category: '高中', sort: 2 }
    ];
    const listDiffSort = [
      { id: 'CAMP_1', name: '師大附中', category: '高中', sort: 2 },
      { id: 'CAMP_2', name: '北一女中', category: '高中', sort: 1 }
    ];

    assert.strictEqual(store.areCampusListsEqual(listA, listB), true);
    assert.strictEqual(store.areCampusListsEqual(listA, listDiffName), false);
    assert.strictEqual(store.areCampusListsEqual(listA, listDiffSort), false);
    assert.strictEqual(store.areCampusListsEqual(listA, listA.slice(0, 1)), false);
  });

  // 3. reorderAndSortCampuses 正確重新計算各分類序號與分類排序
  await test('3. reorderAndSortCampuses 正確重算序號並依「高中 -> 國中 -> 社區排」分類排序', () => {
    const store = new CampusStore();
    const campuses = [
      { id: 'COMM_1', name: '信義社區', category: '社區排', sort: 9 },
      { id: 'CAMP_2', name: '中正國中', category: '國中', sort: 5 },
      { id: 'CAMP_1', name: '建國中學', category: '高中', sort: 8 },
      { id: 'CAMP_3', name: '大安國中', category: '國中', sort: 2 }
    ];

    store.reorderAndSortCampuses(campuses);

    // 分類順序：高中(1) -> 國中(2) -> 社區排(3)
    assert.strictEqual(campuses[0].name, '建國中學');
    assert.strictEqual(campuses[0].sort, 1);

    assert.strictEqual(campuses[1].name, '大安國中');
    assert.strictEqual(campuses[1].sort, 1);

    assert.strictEqual(campuses[2].name, '中正國中');
    assert.strictEqual(campuses[2].sort, 2);

    assert.strictEqual(campuses[3].name, '信義社區');
    assert.strictEqual(campuses[3].sort, 1);
  });

  // 4. 防抖窗口內連續操作聚合
  await test('4. scheduleCampusSync 在防抖窗口內多次操作聚合成 1 次後端請求', async () => {
    let callCount = 0;
    let savedCampuses = [];

    const stateCampuses = [
      { id: 'CAMP_1', name: '校園A', category: '高中', sort: 1 }
    ];

    const store = new CampusStore({
      apiClient: {
        applyCampusChanges: async (c) => {
          callCount++;
          savedCampuses = c;
          return { success: true };
        }
      },
      getCurrentCampuses: () => ({ campuses: stateCampuses, archivedCampuses: [] }),
      debounceMs: 50
    });

    const snap = store.captureSnapshot(stateCampuses, []);

    // 連續排程三次
    stateCampuses[0].name = '校園A-1';
    store.scheduleCampusSync(snap);

    stateCampuses[0].name = '校園A-2';
    store.scheduleCampusSync(snap);

    stateCampuses[0].name = '校園A-3';
    store.scheduleCampusSync(snap);

    assert.strictEqual(store.getPendingCount(), 1);

    // 等待防抖觸發
    await new Promise(r => setTimeout(r, 80));

    assert.strictEqual(callCount, 1, '應只觸發一次後端儲存');
    assert.strictEqual(savedCampuses[0].name, '校園A-3', '儲存內容應為最後一次變更');
    assert.strictEqual(store.getPendingCount(), 0);
  });

  // 5. 無實質變更防護（若排序換過去又換回來，靜默跳過無意義 RPC）
  await test('5. 無實質變更防護：若狀態與快照完全相同，靜默跳過後端請求', async () => {
    let callCount = 0;
    const stateCampuses = [
      { id: 'CAMP_1', name: '校園A', category: '高中', sort: 1 },
      { id: 'CAMP_2', name: '校園B', category: '高中', sort: 2 }
    ];

    const store = new CampusStore({
      apiClient: {
        applyCampusChanges: async () => {
          callCount++;
          return { success: true };
        }
      },
      getCurrentCampuses: () => ({ campuses: stateCampuses, archivedCampuses: [] }),
      debounceMs: 50
    });

    const snap = store.captureSnapshot(stateCampuses, []);

    // 模擬排程但狀態與 snap 相同
    store.scheduleCampusSync(snap);
    await new Promise(r => setTimeout(r, 80));

    assert.strictEqual(callCount, 0, '內容無實質變更時不應發送任何網路請求');
    assert.strictEqual(store.getPendingCount(), 0);
  });

  // 6. 失敗回退：網路或伺服器錯誤時，精確觸發 onRollback 還原快照
  await test('6. 伺服器錯誤時精確觸發 onRollback 回復快照', async () => {
    let rolledBackSnapshot = null;
    let toastError = null;

    const stateCampuses = [
      { id: 'CAMP_1', name: '新校園', category: '高中', sort: 1 }
    ];
    const snap = {
      campuses: [{ id: 'CAMP_1', name: '舊校園', category: '高中', sort: 1 }],
      archivedCampuses: []
    };

    const store = new CampusStore({
      apiClient: {
        applyCampusChanges: async () => ({ success: false, error: '資料庫寫入超時' })
      },
      getCurrentCampuses: () => ({ campuses: stateCampuses, archivedCampuses: [] }),
      onToast: (msg, type) => { if (type === 'error') toastError = msg; },
      onRollback: (rSnap) => { rolledBackSnapshot = rSnap; },
      debounceMs: 50
    });

    store.scheduleCampusSync(snap, true); // immediate = true
    await new Promise(r => setTimeout(r, 20));

    assert.notStrictEqual(rolledBackSnapshot, null, '應觸發 onRollback');
    assert.strictEqual(rolledBackSnapshot.campuses[0].name, '舊校園');
    assert.ok(toastError.includes('資料庫寫入超時'));
  });

  // 7. immediate 模式立即 flush
  await test('7. immediate 模式立即發送請求不等待計時器', async () => {
    let called = false;
    const stateCampuses = [{ id: 'CAMP_1', name: '變更校園', category: '高中', sort: 1 }];

    const store = new CampusStore({
      apiClient: {
        applyCampusChanges: async () => {
          called = true;
          return { success: true };
        }
      },
      getCurrentCampuses: () => ({ campuses: stateCampuses, archivedCampuses: [] }),
      debounceMs: 5000 // 設為極大值確保非 timer 觸發
    });

    const snap = {
      campuses: [{ id: 'CAMP_1', name: '原校園', category: '高中', sort: 1 }],
      archivedCampuses: []
    };

    store.scheduleCampusSync(snap, true);
    assert.strictEqual(called, true, '應立即同步發送請求');
  });

  console.log(`\n=== 恭喜！CampusStore 全部 ${passedTests} 項單元測試順利通過！ ===\n`);
  process.exit(0);
})();
