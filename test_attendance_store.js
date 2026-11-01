/**
 * test_attendance_store.js
 * 
 * 測試 AttendanceStore 前端深模組
 * 100% 脫離瀏覽器 DOM，在 Node.js 本地環境運行極速單元測試。
 * 涵蓋全部 10 大設計意圖：
 * 1. 0ms 樂觀響應與檢索索引 (Optimistic Toggle & Query)
 * 2. 雙態模型與狀態追蹤 (Dual-State: desiredState vs syncedState)
 * 3. 自我消除機制 (Self-Canceling in Debounce Window)
 * 4. 400ms 防抖聚合與批次發送 (Debounce & Batching)
 * 5. 反向行號推算 R' (computeTargetWeekRPrime)
 * 6. 失敗回滾與意圖保護 (Rollback with Intent Preservation)
 * 7. 成員改名連動更新 (renameMember in cache & syncQueue)
 * 8. 一鍵套用預設名單與隊列清理 (applyDefaults)
 * 9. 導航強制同步守衛 (Immediate flush on changeWeek/goHome)
 * 10. 歷史紀錄按需延遲載入 (ensureAttendanceRange & mergeAttendanceHistory)
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 從 index.html 提取 AttendanceStore 類別定義並載入全域
const htmlContent = fs.readFileSync(__dirname + '/index.html', 'utf8');
const startMarker = 'class AttendanceStore {';
const startIdx = htmlContent.indexOf(startMarker);
if (startIdx === -1) {
  console.error('❌ 無法在 index.html 中找到 class AttendanceStore 定義！');
  process.exit(1);
}

// 尋找類別結尾：下一個註解標記 // ===== 伺服器端預載資料
const endMarker = '// ===== 伺服器端預載資料';
const endIdx = htmlContent.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('❌ 無法在 index.html 中找到 AttendanceStore 結尾！');
  process.exit(1);
}

const classCode = htmlContent.slice(startIdx, endIdx).trim();
vm.runInThisContext(classCode);

console.log('=== 開始執行 AttendanceStore 離線單元測試集 ===\n');

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

// 輔助：建立測試用 AttendanceStore 實例
function createTestStore(apiOverrides = {}, options = {}) {
  const apiClient = {
    batchUpdateAttendance: async () => ({ success: true }),
    applyDefaultAttendance: async () => ({ success: true }),
    getAttendanceHistory: async () => ({ success: true, data: { attendanceByCampus: {}, hasMore: false } }),
    ...apiOverrides
  };

  const store = new AttendanceStore({
    apiClient,
    debounceMs: 50, // 測試中縮短防抖時間為 50ms
    maxRetries: 2,
    ...options
  });

  store.loadInitialData({
    'CAMP_01': [
      { name: '張弟兄', week: '2026-08-30', type: '出席', role: '學生' },
      { name: '張弟兄', week: '2026-09-06', type: '出席', role: '學生' },
      { name: '李姊妹', week: '2026-09-06', type: '出席', role: '學生' }
    ],
    'CAMP_02': [
      { name: '王同學', week: '2026-09-06', type: '出席', role: '學生' }
    ]
  }, '2026-08-30');

  store.setCurrentContext('CAMP_01', '2026-09-06');
  return store;
}

(async () => {
  // ----------------------------------------------------
  // 測試 1: 0ms 樂觀響應與檢索索引
  // ----------------------------------------------------
  await test('1. 初始資料載入與當週 O(1) 索引檢索', () => {
    const store = createTestStore();
    assert.strictEqual(store.isMarked('張弟兄', '出席'), true);
    assert.strictEqual(store.isMarked('李姊妹', '出席'), true);
    assert.strictEqual(store.isMarked('張弟兄', '禱告'), false);
    assert.strictEqual(store.isMarked('陌生人', '出席'), false);

    const counts = store.getWeekCounts();
    assert.strictEqual(counts.attend, 2);
    assert.strictEqual(counts.pray, 0);
    assert.strictEqual(counts.gospel, 0);
  });

  // ----------------------------------------------------
  // 測試 2: 雙態模型與即時打卡切換
  // ----------------------------------------------------
  await test('2. toggleRecord 即時切換狀態與計數更新', () => {
    const store = createTestStore();
    
    // 為李姊妹新增「禱告」
    const res1 = store.toggle('李姊妹', '禱告', '學生');
    assert.strictEqual(res1.isMarked, true);
    assert.strictEqual(store.isMarked('李姊妹', '禱告'), true);
    assert.strictEqual(store.getWeekCounts().pray, 1);
    assert.strictEqual(store.getPendingCount(), 1);

    // 取消張弟兄的「出席」
    const res2 = store.toggle('張弟兄', '出席');
    assert.strictEqual(res2.isMarked, false);
    assert.strictEqual(store.isMarked('張弟兄', '出席'), false);
    assert.strictEqual(store.getWeekCounts().attend, 1);
    assert.strictEqual(store.getPendingCount(), 2);
    assert.strictEqual(store.hasChanged(), true);
  });

  // ----------------------------------------------------
  // 測試 3: 自我消除機制 (Self-Canceling)
  // ----------------------------------------------------
  await test('3. 自我消除：在防抖窗口內連按兩次自動消除隊列項目且不發送請求', async () => {
    let apiCallCount = 0;
    const store = createTestStore({
      batchUpdateAttendance: async () => {
        apiCallCount++;
        return { success: true };
      }
    });

    // 點擊新增禱告，隨即再次點擊取消
    store.toggle('李姊妹', '禱告');
    assert.strictEqual(store.getPendingCount(), 1);

    store.toggle('李姊妹', '禱告');
    // 期望回到初始 syncedState，直接自隊列移除
    assert.strictEqual(store.getPendingCount(), 0);
    assert.strictEqual(store.isMarked('李姊妹', '禱告'), false);

    // 等待防抖時間過去
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(apiCallCount, 0, '自我消除後不應發起任何伺服器請求');
  });

  // ----------------------------------------------------
  // 測試 4: 防抖聚合批次送出
  // ----------------------------------------------------
  await test('4. 防抖聚合：連續操作在單次 RPC 請求中合併送出', async () => {
    let capturedPayload = null;
    const store = createTestStore({
      batchUpdateAttendance: async (campus, week, marks, unmarks, rPrime) => {
        capturedPayload = { campus, week, marks, unmarks, rPrime };
        return { success: true };
      }
    });

    store.toggle('陳同學', '出席', '學生');
    store.toggle('李姊妹', '禱告', '學生');
    store.toggle('張弟兄', '出席', '學生'); // 取消出席

    assert.strictEqual(store.getPendingCount(), 3);

    // 等待 50ms 防抖觸發 flush
    await new Promise(r => setTimeout(r, 80));

    assert.ok(capturedPayload, '防抖時間結束後應發起批次更新');
    assert.strictEqual(capturedPayload.campus, 'CAMP_01');
    assert.strictEqual(capturedPayload.week, '2026-09-06');
    assert.strictEqual(capturedPayload.marks.length, 2, '應包含陳同學出席與李姊妹禱告');
    assert.strictEqual(capturedPayload.unmarks.length, 1, '應包含張弟兄取消出席');
    assert.strictEqual(store.getPendingCount(), 0, '成功後隊列應清空');
  });

  // ----------------------------------------------------
  // 測試 5: 反向推算行號 R' (computeTargetWeekRPrime)
  // ----------------------------------------------------
  await test('5. computeTargetWeekRPrime 精準反向計算大於等於目標週次之紀錄總筆數', () => {
    const store = createTestStore();
    // CAMP_01:
    //   2026-08-30: 1 筆
    //   2026-09-06: 2 筆
    // CAMP_02:
    //   2026-09-06: 1 筆
    // >= 2026-09-06: 2 + 1 = 3 筆
    const rPrimeCurrent = store.computeTargetWeekRPrime('2026-09-06');
    assert.strictEqual(rPrimeCurrent, 3);

    // >= 2026-08-30: 1 + 2 + 1 = 4 筆
    const rPrimeOld = store.computeTargetWeekRPrime('2026-08-30');
    assert.strictEqual(rPrimeOld, 4);

    // 比快取最舊週次還早（未載入）：應回傳 0 讓後端採安全退避探測
    const rPrimeUnknown = store.computeTargetWeekRPrime('2026-01-01');
    assert.strictEqual(rPrimeUnknown, 0);
  });

  // ----------------------------------------------------
  // 測試 6: 失敗回滾與意圖保護 (Intent Protection)
  // ----------------------------------------------------
  await test('6. 失敗回滾與意圖保護：傳輸中二次修改之項目不被舊失敗覆蓋', async () => {
    const store = createTestStore({
      batchUpdateAttendance: async () => {
        await new Promise(r => setTimeout(r, 20));
        throw new Error('模擬網路斷線');
      }
    }, { maxRetries: 1 }); // 測試中重試 1 次以加速驗證

    // 1. 使用者取消「張弟兄」的出席
    store.toggle('張弟兄', '出席');
    assert.strictEqual(store.isMarked('張弟兄', '出席'), false);

    // 2. 立即發起 flush（此時進入 in-flight 傳輸 20ms）
    const flushPromise = store.flush();

    // 3. 在網路傳輸途中，使用者又改變心意點了出席 (desiredState = true)
    store.toggle('張弟兄', '出席');
    assert.strictEqual(store.isMarked('張弟兄', '出席'), true);

    // 4. 等待伺服器回傳失敗
    await flushPromise;

    // 5. 驗證：張弟兄的出席不應被回滾掉，仍應維持使用者最新的「出席」期望！
    assert.strictEqual(store.isMarked('張弟兄', '出席'), true, '新意圖應被保護');
  });

  // ----------------------------------------------------
  // 測試 7: 成員改名跨結構連動 (renameMember)
  // ----------------------------------------------------
  await test('7. renameMember 同步更新快取、當週索引與待同步隊列', async () => {
    let capturedMarks = null;
    const store = createTestStore({
      batchUpdateAttendance: async (c, w, marks) => {
        capturedMarks = marks;
        return { success: true };
      }
    });

    // 新增「周同學」禱告
    store.toggle('周同學', '禱告', '學生');
    assert.strictEqual(store.isMarked('周同學', '禱告'), true);

    // 成員改名為「周弟兄」
    store.renameMember('周同學', '周弟兄');

    // 驗證當週索引已替換
    assert.strictEqual(store.isMarked('周同學', '禱告'), false);
    assert.strictEqual(store.isMarked('周弟兄', '禱告'), true);

    // 執行同步，確認發送的是新名字，絕不發送舊名
    await store.flush();
    assert.ok(capturedMarks);
    assert.strictEqual(capturedMarks[0].name, '周弟兄');
  });

  // ----------------------------------------------------
  // 測試 8: 一鍵套用預設名單 (applyDefaults)
  // ----------------------------------------------------
  await test('8. applyDefaults 樂觀覆蓋當週紀錄並清空待同步隊列', async () => {
    let capturedRecords = null;
    const store = createTestStore({
      applyDefaultAttendance: async (c, w, records) => {
        capturedRecords = records;
        return { success: true };
      }
    });

    // 預先在隊列中留一個操作
    store.toggle('張弟兄', '禱告', '學生');
    assert.strictEqual(store.getPendingCount(), 1);

    // 一鍵套用預設：只有 王長老 出席與禱告
    const defRecords = [
      { name: '王長老', type: '出席', role: '服事者' },
      { name: '王長老', type: '禱告', role: '服事者' }
    ];
    await store.applyDefaults(defRecords);

    // 原有的張弟兄、李姊妹當週紀錄應全被替換
    assert.strictEqual(store.isMarked('張弟兄', '出席'), false);
    assert.strictEqual(store.isMarked('王長老', '出席'), true);
    assert.strictEqual(store.isMarked('王長老', '禱告'), true);
    assert.strictEqual(store.getWeekCounts().attend, 1);
    assert.strictEqual(store.getWeekCounts().pray, 1);

    // 當週隊列應已被清理
    assert.strictEqual(store.getPendingCount(), 0);
    assert.strictEqual(capturedRecords.length, 2);
  });

  // ----------------------------------------------------
  // 測試 9: 導航強制同步守衛 (Navigation Flush Guard)
  // ----------------------------------------------------
  await test('9. 導航切換時立即調用 flush() 不等待計時器', async () => {
    let apiCalled = false;
    const store = createTestStore({
      batchUpdateAttendance: async () => {
        apiCalled = true;
        return { success: true };
      }
    });

    store.toggle('李姊妹', '傳福音', '學生');
    assert.strictEqual(apiCalled, false);

    // 模擬導航切換呼叫 flush()
    await store.flush();
    assert.strictEqual(apiCalled, true, 'flush() 應立即發送請求');
    assert.strictEqual(store.getPendingCount(), 0);
  });

  // ----------------------------------------------------
  // 測試 10: 歷史按需加載 (ensureAttendanceRange & merge)
  // ----------------------------------------------------
  await test('10. setWeek 超出快取範圍時自動呼叫 getAttendanceHistory 並頭部拼接', async () => {
    let requestedStartWeek = null;
    const store = createTestStore({
      getAttendanceHistory: async (startWeek, endWeek) => {
        requestedStartWeek = startWeek;
        return {
          success: true,
          data: {
            attendanceByCampus: {
              'CAMP_01': [
                { name: '古早人', week: '2026-05-03', type: '出席', role: '學生' }
              ]
            },
            hasMore: false
          }
        };
      }
    });

    // 目前 minLoadedWeek 為 2026-08-30
    // 切換到更早的 2026-05-03
    await store.setWeek('2026-05-03');

    assert.ok(requestedStartWeek, '應觸發歷史拉取');
    assert.strictEqual(store.isMarked('古早人', '出席'), true);
    assert.strictEqual(store.getWeekCounts().attend, 1);
    // minLoadedWeek 應標記為無更早資料 '0000-00-00'
    assert.strictEqual(store.minLoadedWeek, '0000-00-00');
  });

  console.log(`\n=== 恭喜！AttendanceStore 全部 ${passedTests} 項單元測試順利通過！ ===`);
})();
