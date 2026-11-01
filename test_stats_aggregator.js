/**
 * test_stats_aggregator.js
 * 
 * 測試 StatsAggregator 與 Timeline 統計計算深模組
 * 100% 脫離瀏覽器 DOM，在 Node.js 本地環境運行極速單元測試。
 * 
 * 涵蓋測試場景：
 * 1. Timeline 週一與週日對齊 (getMonday / getSunday)
 * 2. Timeline 最近 N 週區間計算 (recentWeeks)
 * 3. Timeline 學期區間計算與進行中截止週對齊 (semester)
 * 4. Timeline 時間軸平移與最大允許週日邊界校準 (shift)
 * 5. Timeline 動態週次清單展開 (buildWeekList & 倒反日期防護)
 * 6. StatsAggregator 服事者/家長全面排除 (Serving Ones Exclusion)
 * 7. StatsAggregator 福音朋友認定與出席/請假/禱告/出訪分流
 * 8. StatsAggregator 三大 KPI 運算與零除安全防護 (avgAttend, avgGospel, activeGospel)
 * 9. StatsAggregator 活躍福音朋友門檻與嚴格大於檢驗 (Strictly Greater Threshold)
 * 10. StatsAggregator 單校暫停週扣除 vs 全體匯總不扣除 (Suspension Deduction)
 * 11. StatsAggregator 跨校排行榜平均排序與趨勢狀態機 (UP, DOWN, FLAT, SUSPENDED)
 * 12. StatsAggregator 空資料與異常輸入容錯 (Zero Crash Guarantee)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 載入純淨的 src/js/stats_aggregator.js
const code = fs.readFileSync(path.join(__dirname, 'src', 'js', 'stats_aggregator.js'), 'utf8');
vm.runInThisContext(code);

console.log('=== 開始執行 StatsAggregator & Timeline 離線單元測試集 ===\n');

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
// 1. Timeline 週一與週日對齊
// ----------------------------------------------------
test('1. Timeline.getMonday 與 Timeline.getSunday 正確推算同週週一與週日', () => {
  // 2026-09-06 為週日，其對應週一應為 2026-08-31
  const sunDate = new Date(2026, 8, 6);  // 9/6 (週日)
  const monDate = new Date(2026, 7, 31); // 8/31 (週一，8月月份為 7)
  const wedDate = new Date(2026, 8, 2);  // 9/2 (週三)

  assert.strictEqual(Timeline.formatDate(Timeline.getSunday(sunDate)), '2026-09-06');
  assert.strictEqual(Timeline.formatDate(Timeline.getMonday(sunDate)), '2026-08-31');

  assert.strictEqual(Timeline.formatDate(Timeline.getSunday(monDate)), '2026-09-06');
  assert.strictEqual(Timeline.formatDate(Timeline.getMonday(monDate)), '2026-08-31');

  assert.strictEqual(Timeline.formatDate(Timeline.getSunday(wedDate)), '2026-09-06');
  assert.strictEqual(Timeline.formatDate(Timeline.getMonday(wedDate)), '2026-08-31');
});

// ----------------------------------------------------
// 2. Timeline 最近 N 週區間計算
// ----------------------------------------------------
test('2. Timeline.recentWeeks 正確計算指定週數區間', () => {
  const refDate = new Date(2026, 8, 6); // 2026-09-06 (週日)
  const w10 = Timeline.recentWeeks(10, refDate);
  assert.strictEqual(w10.endDate, '2026-09-06');
  assert.strictEqual(w10.startDate, '2026-07-05'); // 往前推 9 週 (共 10 週)

  const list = Timeline.buildWeekList(w10.startDate, w10.endDate);
  assert.strictEqual(list.length, 10);
  assert.strictEqual(list[0].sunStr, '2026-07-05');
  assert.strictEqual(list[9].sunStr, '2026-09-06');

  const w20 = Timeline.recentWeeks(20, refDate);
  const list20 = Timeline.buildWeekList(w20.startDate, w20.endDate);
  assert.strictEqual(list20.length, 20);
});

// ----------------------------------------------------
// 3. Timeline 學期區間計算與截止日對齊
// ----------------------------------------------------
test('3. Timeline.semester 學期起訖與進行中學期截斷', () => {
  // 基準日設在學期進行中：2026-04-15 (春季學期進行中)
  const midSpring = new Date(2026, 3, 15);
  const springRes = Timeline.semester(2026, 'SPRING', midSpring);
  // 開始週日應為 3/1 所在週的週日 (2026-03-01 本身為週日)
  assert.strictEqual(springRes.startDate, '2026-03-01');
  // 結束週日因學期未完，不可超過 4/15 所在的週日 (2026-04-19)
  assert.strictEqual(springRes.endDate, '2026-04-19');

  // 基準日設在學期結束後：2026-08-01
  const afterSpring = new Date(2026, 7, 1);
  const fullSpring = Timeline.semester(2026, 'SPRING', afterSpring);
  assert.strictEqual(fullSpring.startDate, '2026-03-01');
  // 6 月底所在週日為 2026-07-05 (2026-06-30 為週二，所屬週日為 7/5)
  assert.strictEqual(fullSpring.endDate, '2026-07-05');

  // CURRENT 自動判定：4 月份為春季學期
  const curRes = Timeline.semester(2026, 'CURRENT', midSpring);
  assert.strictEqual(curRes.startDate, springRes.startDate);
  assert.strictEqual(curRes.endDate, springRes.endDate);
});

// ----------------------------------------------------
// 4. Timeline 平移與邊界對齊
// ----------------------------------------------------
test('4. Timeline.shift 往前/往後推移，並在觸頂時對齊上限保持跨度', () => {
  const maxSun = new Date(2026, 8, 6); // 2026-09-06
  // 往前平移 2 週
  const shiftedBack = Timeline.shift('2026-08-09', '2026-09-06', -2, maxSun);
  assert.strictEqual(shiftedBack.startDate, '2026-07-26');
  assert.strictEqual(shiftedBack.endDate, '2026-08-23');

  // 嘗試往後平移 5 週，會超過 maxSun (2026-09-06)，應被自動對齊回 2026-09-06 且跨度維持不變
  const shiftedOver = Timeline.shift('2026-07-26', '2026-08-23', 5, maxSun);
  assert.strictEqual(shiftedOver.endDate, '2026-09-06');
  assert.strictEqual(shiftedOver.startDate, '2026-08-09');
});

// ----------------------------------------------------
// 5. Timeline buildWeekList 與異常輸入防護
// ----------------------------------------------------
test('5. Timeline.buildWeekList 正確生成標籤且在起日晚於迄日時回傳空陣列', () => {
  const normalList = Timeline.buildWeekList('2026-08-23', '2026-09-06');
  assert.strictEqual(normalList.length, 3);
  assert.strictEqual(normalList[0].shortLabel, '8/23');
  assert.strictEqual(normalList[0].weekStr, '2026-08-17'); // 對應點名週一
  assert.strictEqual(normalList[2].shortLabel, '9/6');
  assert.strictEqual(normalList[2].weekStr, '2026-08-31');

  // 倒反區間防護
  const invalidList = Timeline.buildWeekList('2026-09-06', '2026-08-23');
  assert.deepStrictEqual(invalidList, []);
  // 空輸入防護
  assert.deepStrictEqual(Timeline.buildWeekList('', ''), []);
});

// ----------------------------------------------------
// 6. StatsAggregator 服事者/家長全面排除
// ----------------------------------------------------
test('6. StatsAggregator 點名紀錄中「服事者/家長」絕不計入出席或福音', () => {
  const attendanceByCampus = {
    'CAMP_01': [
      { week: '2026-08-31', type: '出席', name: '大專服事者', role: '服事者/家長' },
      { week: '2026-08-31', type: '出席', name: '愛心家長', role: '服事者/家長' },
      { week: '2026-08-31', type: '出席', name: '學生小明', role: '學生' },
      { week: '2026-08-31', type: '出席', name: '福音友人', role: '男界朋友' }
    ]
  };
  const campuses = [{ id: 'CAMP_01', name: '中央大學', category: '大學' }];

  const report = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-09-06',
    endDate: '2026-09-06',
    targetCampusId: 'CAMP_01'
  });

  // 服事者2人不計入，僅計入 學生小明(1) + 福音友人(1) = 2 人
  assert.strictEqual(report.kpis.attendance.total, 2);
  assert.strictEqual(report.latest.attend, 2);
  // 福音朋友計入 1 人
  assert.strictEqual(report.kpis.gospel.total, 1);
  assert.strictEqual(report.latest.gospel, 1);
});

// ----------------------------------------------------
// 7. StatsAggregator 類型分流 (出席, 請假, 禱告, 出訪)
// ----------------------------------------------------
test('7. StatsAggregator 正確分流各指標類別並排除請假', () => {
  const attendanceByCampus = {
    'CAMP_01': [
      { week: '2026-08-31', type: '出席', name: '張同學', role: '學生' },
      { week: '2026-08-31', type: '請假', name: '李同學', role: '學生' },
      { week: '2026-08-31', type: '禱告', name: '王同學', role: '學生' },
      { week: '2026-08-31', type: '禱告', name: '張同學', role: '學生' },
      { week: '2026-08-31', type: '傳福音', name: '張同學', role: '學生' }
    ]
  };
  const campuses = [{ id: 'CAMP_01', name: '中央大學', category: '大學' }];

  const report = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-09-06',
    endDate: '2026-09-06'
  });

  assert.strictEqual(report.series.attend[0], 1); // 僅張同學出席（李同學請假不計）
  assert.strictEqual(report.series.pray[0], 2);   // 王、張 2人禱告
  assert.strictEqual(report.series.outreach[0], 1); // 張 1人傳福音
  assert.strictEqual(report.series.gospel[0], 0);   // 無福音朋友
});

// ----------------------------------------------------
// 8. StatsAggregator 零除安全防護
// ----------------------------------------------------
test('8. StatsAggregator 在完全無點名資料時安全輸出 0.0，不拋錯', () => {
  const campuses = [{ id: 'CAMP_01', name: '中壢高中', category: '高中' }];
  const report = StatsAggregator.aggregate({
    attendanceByCampus: {},
    campuses,
    startDate: '2026-08-23',
    endDate: '2026-09-06'
  });

  assert.strictEqual(report.kpis.attendance.total, 0);
  assert.strictEqual(report.kpis.attendance.avg, 0);
  assert.strictEqual(report.kpis.attendance.formattedAvg, '0.0');
  assert.strictEqual(report.kpis.gospel.avg, 0);
  assert.strictEqual(report.kpis.gospel.formattedAvg, '0.0');
  assert.strictEqual(report.kpis.activeGospel.count, 0);
  assert.strictEqual(report.kpis.activeGospel.totalFriends, 0);
  assert.strictEqual(report.kpis.activeGospel.threshold, 0);
  assert.strictEqual(report.kpis.activeGospel.formattedThreshold, '0.0');
});

// ----------------------------------------------------
// 9. StatsAggregator 活躍福音朋友門檻與嚴格大於檢驗
// ----------------------------------------------------
test('9. StatsAggregator 活躍福音朋友需「嚴格大於」平均出席次數方能達標', () => {
  // 設定兩週區間: 8/30 (週日), 9/6 (週日)
  // 週一分別為: 2026-08-24, 2026-08-31
  // 朋友甲：出席 2 次
  // 朋友乙：出席 1 次
  // 朋友丙：出席 1 次
  // 總出席人次 = 4, 朋友總數 = 3, 平均出席門檻 = 4 / 3 ≈ 1.33 次
  // 達標者 (出席次數 > 1.33): 僅朋友甲 (2 > 1.33)；乙和丙為 1 次未達標
  const attendanceByCampus = {
    'CAMP_01': [
      { week: '2026-08-24', type: '出席', name: '朋友甲', role: '男界朋友' },
      { week: '2026-08-31', type: '出席', name: '朋友甲', role: '男界朋友' },
      { week: '2026-08-24', type: '出席', name: '朋友乙', role: '女界朋友' },
      { week: '2026-08-31', type: '出席', name: '朋友丙', role: '女界朋友' }
    ]
  };
  const campuses = [{ id: 'CAMP_01', name: '測試排', category: '社區排' }];

  const report = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-08-30',
    endDate: '2026-09-06'
  });

  assert.strictEqual(report.kpis.gospel.total, 4);
  assert.strictEqual(report.kpis.activeGospel.totalFriends, 3);
  assert.strictEqual(report.kpis.activeGospel.formattedThreshold, '1.3');
  assert.strictEqual(report.kpis.activeGospel.count, 1); // 只有朋友甲達標
});

// ----------------------------------------------------
// 10. StatsAggregator 單校暫停週扣除 vs 全體匯總
// ----------------------------------------------------
test('10. StatsAggregator 單校勾選排除暫停週時精準扣除，全體匯總不扣除', () => {
  // 3 週區間: 8/23 (8/17), 8/30 (8/24), 9/6 (8/31)
  const attendanceByCampus = {
    'CAMP_01': [
      { week: '2026-08-17', type: '出席', name: '小王', role: '學生' },
      { week: '2026-08-31', type: '出席', name: '小王', role: '學生' }
    ]
  };
  const campuses = [
    { id: 'CAMP_01', name: '中壢國中', category: '國中', suspendedWeeks: ['2026-08-24'] }
  ];

  // 情境 A: 單校且未勾選排除
  const repNoExclude = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-08-23',
    endDate: '2026-09-06',
    targetCampusId: 'CAMP_01',
    excludeSuspended: false
  });
  assert.strictEqual(repNoExclude.window.totalWeeks, 3);
  assert.strictEqual(repNoExclude.window.effectiveWeeksCount, 3);
  assert.strictEqual(repNoExclude.window.suspendedCount, 0);
  assert.strictEqual(repNoExclude.window.isExcludingSuspended, false);
  // 總出席 2 人，平均 = 2 / 3 = 0.67 -> 0.7
  assert.strictEqual(repNoExclude.kpis.attendance.formattedAvg, '0.7');

  // 情境 B: 單校且勾選排除暫停週
  const repExclude = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-08-23',
    endDate: '2026-09-06',
    targetCampusId: 'CAMP_01',
    excludeSuspended: true
  });
  assert.strictEqual(repExclude.window.totalWeeks, 3);
  assert.strictEqual(repExclude.window.effectiveWeeksCount, 2); // 扣除 1 週
  assert.strictEqual(repExclude.window.suspendedCount, 1);
  assert.strictEqual(repExclude.window.isExcludingSuspended, true);
  // 總出席 2 人，平均 = 2 / 2 = 1.0
  assert.strictEqual(repExclude.kpis.attendance.formattedAvg, '1.0');

  // 情境 C: 全體匯總模式下，excludeSuspended 不生效
  const repAll = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-08-23',
    endDate: '2026-09-06',
    targetCampusId: 'ALL',
    excludeSuspended: true
  });
  assert.strictEqual(repAll.window.totalWeeks, 3);
  assert.strictEqual(repAll.window.effectiveWeeksCount, 3);
  assert.strictEqual(repAll.window.isExcludingSuspended, false);
});

// ----------------------------------------------------
// 11. StatsAggregator 跨校排行榜平均排序與趨勢狀態機
// ----------------------------------------------------
test('11. StatsAggregator 跨校排行榜按平均出席降序排列，且趨勢狀態正確判定', () => {
  // 2 週區間: 8/30 (上週 8/24), 9/6 (本週 8/31)
  const attendanceByCampus = {
    'C_UP': [
      { week: '2026-08-24', type: '出席', name: 'A1', role: '學生' },
      { week: '2026-08-31', type: '出席', name: 'A1', role: '學生' },
      { week: '2026-08-31', type: '出席', name: 'A2', role: '學生' }
    ], // 上週1, 本週2 -> UP (+1), 總計3, 平均1.5
    'C_DOWN': [
      { week: '2026-08-24', type: '出席', name: 'B1', role: '學生' },
      { week: '2026-08-24', type: '出席', name: 'B2', role: '學生' },
      { week: '2026-08-31', type: '出席', name: 'B1', role: '學生' }
    ], // 上週2, 本週1 -> DOWN (-1), 總計3, 平均1.5
    'C_FLAT': [
      { week: '2026-08-24', type: '出席', name: 'C1', role: '學生' },
      { week: '2026-08-31', type: '出席', name: 'C1', role: '學生' }
    ], // 上週1, 本週1 -> FLAT (0), 總計2, 平均1.0
    'C_SUS_THIS': [
      { week: '2026-08-24', type: '出席', name: 'D1', role: '學生' }
    ], // 本週暫停 -> THIS_WEEK_SUSPENDED
    'C_SUS_PREV': [
      { week: '2026-08-31', type: '出席', name: 'E1', role: '學生' }
    ]  // 上週暫停 -> PREV_WEEK_SUSPENDED
  };

  const campuses = [
    { id: 'C_FLAT', name: '平穩校園', category: '國中' },
    { id: 'C_DOWN', name: '下滑校園', category: '高中' },
    { id: 'C_UP', name: '成長校園', category: '高中' },
    { id: 'C_SUS_THIS', name: '本週暫停校園', category: '社區排', suspendedWeeks: ['2026-08-31'] },
    { id: 'C_SUS_PREV', name: '上週暫停校園', category: '社區排', suspendedWeeks: ['2026-08-24'] }
  ];

  const report = StatsAggregator.aggregate({
    attendanceByCampus,
    campuses,
    startDate: '2026-08-30',
    endDate: '2026-09-06'
  });

  const rank = report.campusRankings;
  assert.strictEqual(rank.length, 5);

  // 排序檢查：前兩名平均 1.5，第 3 名 1.0，後續為 0.5
  assert.ok(rank[0].avgAttend >= rank[1].avgAttend);
  assert.ok(rank[1].avgAttend >= rank[2].avgAttend);

  const getRank = (cid) => rank.find(r => r.id === cid);
  assert.strictEqual(getRank('C_UP').trendStatus, 'UP');
  assert.strictEqual(getRank('C_UP').diff, 1);

  assert.strictEqual(getRank('C_DOWN').trendStatus, 'DOWN');
  assert.strictEqual(getRank('C_DOWN').diff, -1);

  assert.strictEqual(getRank('C_FLAT').trendStatus, 'FLAT');
  assert.strictEqual(getRank('C_FLAT').diff, 0);

  assert.strictEqual(getRank('C_SUS_THIS').trendStatus, 'THIS_WEEK_SUSPENDED');
  assert.strictEqual(getRank('C_SUS_PREV').trendStatus, 'PREV_WEEK_SUSPENDED');
});

// ----------------------------------------------------
// 12. StatsAggregator 異常輸入容錯
// ----------------------------------------------------
test('12. StatsAggregator 面對 undefined / null 各種邊界皆能平穩運行不潰散', () => {
  const rep1 = StatsAggregator.aggregate();
  assert.strictEqual(rep1.window.totalWeeks, 0);
  assert.strictEqual(rep1.campusRankings.length, 0);

  const rep2 = StatsAggregator.aggregate({
    attendanceByCampus: null,
    campuses: null,
    startDate: null,
    endDate: null
  });
  assert.strictEqual(rep2.window.totalWeeks, 0);
  assert.strictEqual(rep2.kpis.attendance.avg, 0);
});

// ----------------------------------------------------
// 13. 建置產物 index.html 完整性驗證
// ----------------------------------------------------
test('13. 建置產物 index.html 完整內嵌 StatsAggregator 與 Timeline 且能正常執行', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes('const Timeline = {'), 'index.html 應包含 Timeline');
  assert.ok(html.includes('const StatsAggregator = {'), 'index.html 應包含 StatsAggregator');
  
  // 驗證在獨立 VM 執行 index.html 中的內嵌主腳本片段
  const scriptMatch = html.match(/<script(?![^>]*src=)[\s\S]*?>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch && scriptMatch[1].length > 0, 'index.html 應有內嵌主 <script> 標籤');
  const sanitizedScript = scriptMatch[1].replace(/<\?!=[\s\S]*?\?>/g, 'null');
  
  // 建立乾淨沙盒環境
  const sandbox = {
    document: {
      getElementById: () => ({ classList: { add: () => {}, remove: () => {} }, style: {} }),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    window: {
      devicePixelRatio: 1,
      scrollTo: () => {},
      addEventListener: () => {}
    },
    console: console
  };
  const ctx = vm.createContext(sandbox);
  // 在腳本末尾將 Timeline 和 StatsAggregator 掛載至沙盒全域變數以供外部驗證
  vm.runInContext(sanitizedScript + '\n;globalThis.__T__ = Timeline; globalThis.__S__ = StatsAggregator;', ctx);

  const timeline = sandbox.__T__;
  const aggregator = sandbox.__S__;
  assert.ok(timeline && typeof timeline.buildWeekList === 'function', '沙盒中應能存取 Timeline');
  assert.ok(aggregator && typeof aggregator.aggregate === 'function', '沙盒中應能存取 StatsAggregator');
  const testWeeks = timeline.buildWeekList('2026-08-30', '2026-09-06');
  assert.strictEqual(testWeeks.length, 2);
});

test('14. StatsAggregator.sortRankings 支援全欄位升降序、暫停週走勢權重與同向次要排序', () => {
  const rankings = [
    { id: '1', name: '大同校園', latestAttend: 10, avgAttend: 8.5, gospelTotal: 4, diff: 2 },
    { id: '2', name: '和平校園', latestAttend: 5, avgAttend: 12.0, gospelTotal: 10, diff: -1 },
    { id: '3', name: '成功校園', latestAttend: 10, avgAttend: 9.0, gospelTotal: 2, diff: 0 }
  ];

  // 1. 最新週降序 (平手時次要排序 avgAttend 也為降序: 成功 9.0 > 大同 8.5)
  const byLatestDesc = StatsAggregator.sortRankings(rankings, 'latestAttend', 'desc');
  assert.strictEqual(byLatestDesc[0].id, '3', '最新週相同且降序時，區間平均較高者在前');
  assert.strictEqual(byLatestDesc[1].id, '1');
  assert.strictEqual(byLatestDesc[2].id, '2');

  // 2. 最新週升序 (平手時次要排序 avgAttend 也為升序: 大同 8.5 < 成功 9.0)
  const byLatestAsc = StatsAggregator.sortRankings(rankings, 'latestAttend', 'asc');
  assert.strictEqual(byLatestAsc[0].id, '2'); // latestAttend: 5
  assert.strictEqual(byLatestAsc[1].id, '1', '最新週相同且升序時，區間平均較低者在前 (次要排序亦為升序)');
  assert.strictEqual(byLatestAsc[2].id, '3');

  // 3. 區間平均主排序平手時，次要排序比最新週 latestAttend，且方向與主排序一致
  const avgTieRankings = [
    { id: 'A', name: '甲校', avgAttend: 8.0, latestAttend: 10 },
    { id: 'B', name: '乙校', avgAttend: 8.0, latestAttend: 4 }
  ];
  const byAvgTieDesc = StatsAggregator.sortRankings(avgTieRankings, 'avgAttend', 'desc');
  assert.strictEqual(byAvgTieDesc[0].id, 'A', 'avgAttend平手降序時，最新週較大者優先');
  const byAvgTieAsc = StatsAggregator.sortRankings(avgTieRankings, 'avgAttend', 'asc');
  assert.strictEqual(byAvgTieAsc[0].id, 'B', 'avgAttend平手升序時，最新週較小者優先 (次要排序亦為升序)');

  // 4. 走勢排序：上週暫停視為 -1000，本週暫停視為 -2000
  const trendRankings = [
    { id: 'T1', name: '走勢成長校', diff: 3, avgAttend: 7.0 },
    { id: 'T2', name: '走勢衰退校', diff: -2, avgAttend: 6.0 },
    { id: 'T3', name: '上週暫停校', trendStatus: 'PREV_WEEK_SUSPENDED', diff: 0, avgAttend: 5.0 },
    { id: 'T4', name: '本週暫停校', trendStatus: 'THIS_WEEK_SUSPENDED', diff: 0, avgAttend: 8.0 },
    { id: 'T5', name: '走勢成長校2', diff: 3, avgAttend: 9.0 }
  ];

  // 走勢降序 (由大到小：成長 +3 -> 衰退 -2 -> 上週暫停 -1000 -> 本週暫停 -2000)
  // T1 與 T5 皆為 +3，次要排序 avgAttend 降序：T5 (9.0) > T1 (7.0)
  const byTrendDesc = StatsAggregator.sortRankings(trendRankings, 'trend', 'desc');
  assert.strictEqual(byTrendDesc[0].id, 'T5', '+3 (avg 9.0) 降序排第 1');
  assert.strictEqual(byTrendDesc[1].id, 'T1', '+3 (avg 7.0) 降序排第 2');
  assert.strictEqual(byTrendDesc[2].id, 'T2', '-2 降序排第 3');
  assert.strictEqual(byTrendDesc[3].id, 'T3', '上週暫停(-1000) 降序排第 4');
  assert.strictEqual(byTrendDesc[4].id, 'T4', '本週暫停(-2000) 降序排第 5');

  // 走勢升序 (由小到大：本週暫停 -2000 -> 上週暫停 -1000 -> 衰退 -2 -> 成長 +3)
  // T1 與 T5 皆為 +3，次要排序 avgAttend 升序：T1 (7.0) < T5 (9.0)
  const byTrendAsc = StatsAggregator.sortRankings(trendRankings, 'trend', 'asc');
  assert.strictEqual(byTrendAsc[0].id, 'T4', '本週暫停(-2000) 升序排第 1');
  assert.strictEqual(byTrendAsc[1].id, 'T3', '上週暫停(-1000) 升序排第 2');
  assert.strictEqual(byTrendAsc[2].id, 'T2', '-2 升序排第 3');
  assert.strictEqual(byTrendAsc[3].id, 'T1', '+3 (avg 7.0) 升序排第 4 (次要排序亦為升序)');
  assert.strictEqual(byTrendAsc[4].id, 'T5', '+3 (avg 9.0) 升序排第 5');

  // 5. 校園名稱 name 升序 (繁體中文字排序：大同 -> 成功 -> 和平)
  const byNameAsc = StatsAggregator.sortRankings(rankings, 'name', 'asc');
  assert.strictEqual(byNameAsc[0].id, '1'); // 大同
  assert.strictEqual(byNameAsc[1].id, '3'); // 成功
  assert.strictEqual(byNameAsc[2].id, '2'); // 和平
});

console.log(`\n=== 恭喜！StatsAggregator 全部 ${passedTests} 項單元測試順利通過！ ===\n`);

