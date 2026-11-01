/**
 * test_member_sync.js
 * 
 * 測試成員管理 0ms 樂觀同步管線與伺服器快照記憶體合併機制
 * 100% 脫離瀏覽器 DOM，在 Node.js 本地環境運行極速單元測試。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { MemberStore, sortMemberList } = require('./src/js/member_store.js');

// 模擬前端 state 與全域變數
const state = {
  currentCampusId: 'campus-1',
  members: [],
  membersByCampus: {}
};

// 實例化 MemberStore
const memberStore = new MemberStore({
  apiClient: {
    applyMemberChanges: async () => ({ success: true, members: [] })
  },
  getCurrentCampusId: () => state.currentCampusId,
  debounceMs: 400
});

const mergeServerMembersWithPendingQueue = (...args) => memberStore.mergeServerMembersWithPendingQueue(...args);
const scheduleMemberSync = (...args) => memberStore.scheduleMemberSync(...args);
const getMemberSyncQueue = () => memberStore.getQueue();
const setMemberSyncQueue = (q) => memberStore.setQueue(q);
const getMemberPendingCount = () => memberStore.getPendingCount();

console.log('=== 開始執行 MemberSync & In-Memory Merge 離線單元測試集 ===\n');

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

// 1. 隊列為空時保持伺服器回傳快照
test('1. 隊列為空時保持伺服器回傳快照並正確深複製', () => {
  const serverMembers = [
    { name: '王小明', count: 5, role: '學生', stage: '國中', defaults: ['出席'] },
    { name: '李大同', count: 3, role: '學員', stage: '高中', defaults: [] }
  ];
  const merged = mergeServerMembersWithPendingQueue(serverMembers, []);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].name, '王小明');
  assert.deepStrictEqual(merged[0].defaults, ['出席']);
  assert.notStrictEqual(merged[0].defaults, serverMembers[0].defaults, 'defaults 應為獨立副本');
});

// 2. 連續點選防回滾：在途請求返回舊快照時保留隊列中的預設值修改 (解決 1 秒短暫回滾)
test('2. 連續點選防回滾：在途請求返回舊快照時，隊列中其他成員的預設值修改不被洗掉', () => {
  const serverSnapshot = [
    { name: '王小明', count: 5, role: '學生', stage: '國中', defaults: ['出席'] },
    { name: '李大同', count: 3, role: '學員', stage: '高中', defaults: [] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-1',
      change: {
        type: 'modify',
        oldName: '李大同',
        name: '李大同',
        role: '學員',
        stage: '高中',
        defaults: ['出席'],
        otherGroupId: ''
      }
    }
  ];

  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].name, '王小明');
  assert.deepStrictEqual(merged[0].defaults, ['出席']);
  assert.strictEqual(merged[1].name, '李大同');
  assert.deepStrictEqual(merged[1].defaults, ['出席'], '李大同的樂觀預設值應被保留，不可回滾為空！');
  assert.strictEqual(merged[1].count, 3, '伺服器端累計出席次數應完整保留');
});

// 3. 待同步新增：隊列中的 add 項目正確併入最新快照
test('3. 待同步新增：隊列中的 add 項目正確併入最新快照', () => {
  const serverSnapshot = [
    { name: '王小明', count: 5, role: '學生', stage: '國中', defaults: [] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-1',
      change: {
        type: 'add',
        name: '新朋友',
        role: '福音朋友',
        stage: '高中',
        defaults: ['出席'],
        otherGroupId: ''
      }
    }
  ];

  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].name, '新朋友');
  assert.strictEqual(merged[1].role, '福音朋友');
  assert.deepStrictEqual(merged[1].defaults, ['出席']);
});

// 4. 待同步刪除：隊列中的 delete 項目正確自最新快照中剔除
test('4. 待同步刪除：隊列中的 delete 項目正確自最新快照中剔除', () => {
  const serverSnapshot = [
    { name: '王小明', count: 5, role: '學生', stage: '國中', defaults: [] },
    { name: '待刪成員', count: 1, role: '學生', stage: '國中', defaults: [] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-1',
      change: {
        type: 'delete',
        name: '待刪成員'
      }
    }
  ];

  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].name, '王小明');
});

// 5. 待同步改名：隊列中的 modify 改名項目正確反映在最新快照中
test('5. 待同步改名：隊列中的 modify 改名項目正確反映在最新快照中', () => {
  const serverSnapshot = [
    { name: '舊名字', count: 10, role: '服事者', stage: '其他', defaults: ['出席'] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-1',
      change: {
        type: 'modify',
        oldName: '舊名字',
        name: '新名字',
        role: '服事者',
        stage: '其他',
        defaults: ['出席', '禱告'],
        otherGroupId: ''
      }
    }
  ];

  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].name, '新名字');
  assert.deepStrictEqual(merged[0].defaults, ['出席', '禱告']);
  assert.strictEqual(merged[0].count, 10);
});

// 6. 校園隔離：其他校園的待同步項目不干擾當前校園之合併
test('6. 校園隔離：其他校園的待同步項目不干擾當前校園之合併', () => {
  const serverSnapshot = [
    { name: '校園1成員', count: 2, role: '學生', stage: '國中', defaults: [] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-2',
      change: {
        type: 'modify',
        name: '校園1成員',
        role: '學生',
        stage: '國中',
        defaults: ['出席']
      }
    }
  ];

  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual(merged[0].defaults, [], 'campus-2 的隊列不可污染 campus-1 的快照');
});

// 7. 隊列聚合：同一成員連續多次修改預設值自動合併為單一隊列項目
test('7. 隊列聚合：同一成員連續多次修改預設值自動合併為單一隊列項目', () => {
  setMemberSyncQueue([]);
  state.currentCampusId = 'campus-1';

  scheduleMemberSync({
    type: 'modify',
    oldName: '張大華',
    name: '張大華',
    role: '學生',
    stage: '國中',
    defaults: ['出席'],
    otherGroupId: ''
  }, () => {});

  scheduleMemberSync({
    type: 'modify',
    oldName: '張大華',
    name: '張大華',
    role: '學生',
    stage: '國中',
    defaults: ['出席', '禱告'],
    otherGroupId: ''
  }, () => {});

  const queue = getMemberSyncQueue();
  assert.strictEqual(queue.length, 1, '多次點選應聚合成 1 個隊列項目');
  assert.deepStrictEqual(queue[0].change.defaults, ['出席', '禱告'], '隊列內容應為最新合併狀態');
});

// 8. 隊列聚合 (Add + Modify)：新增後立即修改預設值
test('8. 隊列聚合 (Add + Modify)：新增後立即修改預設值，隊列保持單一 add 並包含最新欄位', () => {
  setMemberSyncQueue([]);
  state.currentCampusId = 'campus-1';

  scheduleMemberSync({
    type: 'add',
    name: '陳小新',
    role: '學生',
    stage: '國中',
    defaults: [],
    otherGroupId: ''
  }, () => {});

  scheduleMemberSync({
    type: 'modify',
    oldName: '陳小新',
    name: '陳小新',
    role: '學生',
    stage: '國中',
    defaults: ['出席'],
    otherGroupId: ''
  }, () => {});

  const queue = getMemberSyncQueue();
  assert.strictEqual(queue.length, 1, 'add 與後續 modify 應聚合成 1 個 add 項目');
  assert.strictEqual(queue[0].change.type, 'add');
  assert.deepStrictEqual(queue[0].change.defaults, ['出席']);
});

// 9. 隊列自我消除 (Add + Delete)：新增後立即刪除，自動從隊列中移除
test('9. 隊列自我消除 (Add + Delete)：新增後立即刪除，自動從隊列中移除', () => {
  setMemberSyncQueue([]);
  state.currentCampusId = 'campus-1';

  scheduleMemberSync({
    type: 'add',
    name: '臨時成員',
    role: '學生',
    stage: '國中',
    defaults: [],
    otherGroupId: ''
  }, () => {});

  assert.strictEqual(getMemberSyncQueue().length, 1);

  scheduleMemberSync({
    type: 'delete',
    name: '臨時成員'
  }, () => {});

  assert.strictEqual(getMemberSyncQueue().length, 0, '未送至伺服器前的新增被刪除時，隊列應完全清空');
});

// 10. 隊列聚合 (Multi-Rename + Defaults Toggle)：連續改名兩次並切換預設出席
test('10. 隊列聚合 (Multi-Rename + Defaults Toggle)：連續改名兩次並切換預設出席，隊列聚合成 1 個 modify 並保留最初 oldName 與最新 defaults', () => {
  setMemberSyncQueue([]);
  state.currentCampusId = 'campus-1';

  // 1. 改名：張三 -> 張四
  scheduleMemberSync({
    type: 'modify',
    oldName: '張三',
    name: '張四',
    role: '學生',
    stage: '高中',
    defaults: [],
    otherGroupId: ''
  }, () => {});

  // 2. 再改名：張四 -> 張五
  scheduleMemberSync({
    type: 'modify',
    oldName: '張四',
    name: '張五',
    role: '學生',
    stage: '高中',
    defaults: [],
    otherGroupId: ''
  }, () => {});

  // 3. 設定預設出席
  scheduleMemberSync({
    type: 'modify',
    oldName: '張五',
    name: '張五',
    role: '學生',
    stage: '高中',
    defaults: ['出席'],
    otherGroupId: ''
  }, () => {});

  // 4. 取消預設出席
  scheduleMemberSync({
    type: 'modify',
    oldName: '張五',
    name: '張五',
    role: '學生',
    stage: '高中',
    defaults: [],
    otherGroupId: ''
  }, () => {});

  const queue = getMemberSyncQueue();
  assert.strictEqual(queue.length, 1, '四次連續操作應在隊列中聚合成 1 個項目');
  assert.strictEqual(queue[0].change.oldName, '張三', '隊列項目的 oldName 必須保留為最初的張三（使後端試算表能找到原列）');
  assert.strictEqual(queue[0].change.name, '張五', '隊列項目的 name 必須為最新改名張五');
  assert.deepStrictEqual(queue[0].change.defaults, [], '預設值應為最新取消後的空陣列');
});

// 11. 樂觀排序一致性：新增或合併人員時依 (出席次數降序 -> 姓名升序) 排序，避免樂觀更新與儲存後位置跳動
test('11. 樂觀排序一致性：新增或合併人員時依 (出席次數降序 -> 姓名升序) 排序，避免樂觀更新與儲存後位置跳動', () => {
  const members = [
    { name: '王小明', count: 3, role: '學生' },
    { name: '張大華', count: 5, role: '學生' },
    { name: '李大同', count: 0, role: '學員' }
  ];

  // 1. 驗證 sortMemberList 排序邏輯 (5次 > 3次 > 0次)
  sortMemberList(members);
  assert.strictEqual(members[0].name, '張大華', '出席5次者應在第1位');
  assert.strictEqual(members[1].name, '王小明', '出席3次者應在第2位');
  assert.strictEqual(members[2].name, '李大同', '出席0次者應在第3位');

  // 2. 模擬新增 count=0 且姓名排序在前的成員
  const newMember = { name: '安安', count: 0, role: '學生' };
  members.push(newMember);
  sortMemberList(members);
  const zeroCountNames = members.filter(m => m.count === 0).map(m => m.name);
  const expectedZeroNames = ['李大同', '安安'].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(zeroCountNames, expectedZeroNames, 'count 同為 0 者應按 localeCompare 嚴格排序');

  // 3. 驗證 mergeServerMembersWithPendingQueue 併入待新增人員時亦自動排序
  const serverSnapshot = [
    { name: '張大華', count: 5, role: '學生', defaults: [] },
    { name: '李大同', count: 0, role: '學員', defaults: [] }
  ];
  const pendingQueue = [
    {
      campusId: 'campus-1',
      change: {
        type: 'add',
        name: '安安',
        role: '學生',
        stage: '國中',
        defaults: [],
        otherGroupId: ''
      }
    }
  ];
  const merged = mergeServerMembersWithPendingQueue(serverSnapshot, pendingQueue, 'campus-1');
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[0].name, '張大華');
  const mergedZeroNames = [merged[1].name, merged[2].name];
  assert.deepStrictEqual(mergedZeroNames, expectedZeroNames, '合併後 pending 新增者必須處於正確排序位置，絕不跳動');
});

console.log(`\n=== 恭喜！MemberSync 全部 ${passedTests} 項單元測試順利通過！ ===\n`);
process.exit(0);
