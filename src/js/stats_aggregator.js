/**
 * stats_aggregator.js
 * 
 * 統計計算與時間軸深模組（純資料運算、零 DOM、零樣式字串）
 * 包含：
 * 1. Timeline: 時間軸、週次動態生成與日期間距平移工具（以週日代表當週區間）
 * 2. StatsAggregator: 多維索引構建、排除服事者/家長、扣除暫停週、計算 KPI 與校園排行榜
 */

/**
 * Timeline
 * 時間軸與週次計算工具（純函式、無 DOM 依賴）
 * 統一以「週日」代表當週區間（對齊點名應用規範）
 */
const Timeline = {
  /** 格式化日期為 YYYY-MM-DD */
  formatDate(date) {
    if (!date) return '';
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /** 取得給定日期的週一日期（時間歸零） */
  getMonday(date) {
    let d;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
      const parts = date.slice(0, 10).split('-').map(Number);
      d = new Date(parts[0], parts[1] - 1, parts[2]);
    } else if (date) {
      d = new Date(date);
    } else {
      d = new Date();
    }
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  },

  /** 取得給定日期所在週的週日日期（代表該週日期，時間歸零） */
  getSunday(date) {
    const mon = this.getMonday(date);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(0, 0, 0, 0);
    return sun;
  },

  /** 取得當前週的最新週日字串（最大允許迄日） */
  getMaxAllowedSundayStr(refDate = new Date()) {
    return this.formatDate(this.getSunday(refDate));
  },

  /**
   * 計算最近 N 週的區間 [startDate, endDate]（均為週日 YYYY-MM-DD）
   * @param {number} count 週數（如 10, 20）
   * @param {Date|string} [refDate] 參考基準日（預設為今天）
   */
  recentWeeks(count, refDate = new Date()) {
    const curSun = this.getSunday(refDate);
    const startSun = new Date(curSun);
    startSun.setDate(curSun.getDate() - (count - 1) * 7);
    return {
      startDate: this.formatDate(startSun),
      endDate: this.formatDate(curSun)
    };
  },

  /**
   * 計算學期區間 [startDate, endDate]（均為週日 YYYY-MM-DD）
   * @param {number} year 年份
   * @param {'SPRING'|'AUTUMN'|'CURRENT'} term 學期別
   * @param {Date|string} [refDate] 參考基準日
   */
  semester(year, term = 'CURRENT', refDate = new Date()) {
    const curSun = this.getSunday(refDate);
    let isSpring;
    if (term === 'SPRING') {
      isSpring = true;
    } else if (term === 'AUTUMN') {
      isSpring = false;
    } else {
      const refD = (refDate instanceof Date) ? refDate : new Date(refDate);
      const m = refD.getMonth() + 1;
      isSpring = (m >= 2 && m <= 7);
    }

    const startM = isSpring ? 3 : 9;
    const endM = isSpring ? 6 : 12;
    const sSun = this.getSunday(new Date(year, startM - 1, 1));
    const lastDayOfEndM = new Date(year, endM, 0);
    let eSun = this.getSunday(lastDayOfEndM);

    // 若學期仍在進行中，結束週日不可超過基準週日
    if (eSun > curSun) {
      eSun = curSun;
    }

    return {
      startDate: this.formatDate(sSun),
      endDate: this.formatDate(eSun)
    };
  },

  /**
   * 平移時間軸窗口
   * @param {string} startDate 起始週日 YYYY-MM-DD
   * @param {string} endDate 結束週日 YYYY-MM-DD
   * @param {number} deltaWeeks 平移週數（負為往過去，正為往未來）
   * @param {Date|string} [maxSun] 最大允許週日（預設為基準週日）
   */
  shift(startDate, endDate, deltaWeeks, maxSun = this.getSunday(new Date())) {
    const sParts = startDate.split('-').map(Number);
    const eParts = endDate.split('-').map(Number);
    const s = new Date(sParts[0], sParts[1] - 1, sParts[2]);
    let e = new Date(eParts[0], eParts[1] - 1, eParts[2]);

    s.setDate(s.getDate() + deltaWeeks * 7);
    e.setDate(e.getDate() + deltaWeeks * 7);

    const maxLimit = (maxSun instanceof Date) ? maxSun : this.getSunday(maxSun);
    if (e > maxLimit) {
      const diffDays = Math.round((e.getTime() - maxLimit.getTime()) / (24 * 3600 * 1000));
      e = new Date(maxLimit);
      s.setDate(s.getDate() - diffDays);
    }

    return {
      startDate: this.formatDate(s),
      endDate: this.formatDate(e)
    };
  },

  /**
   * 根據起訖週日動態展開所有週次資訊清單
   * @param {string} startDate 起始週日 YYYY-MM-DD
   * @param {string} endDate 結束週日 YYYY-MM-DD
   * @returns {Array<{ weekStr: string, sunStr: string, shortLabel: string, label: string, monday: Date, sunday: Date }>}
   */
  buildWeekList(startDate, endDate) {
    if (!startDate || !endDate) return [];
    const sParts = startDate.split('-').map(Number);
    const eParts = endDate.split('-').map(Number);
    const startSun = this.getSunday(new Date(sParts[0], sParts[1] - 1, sParts[2]));
    const endSun = this.getSunday(new Date(eParts[0], eParts[1] - 1, eParts[2]));
    if (startSun > endSun) return [];

    const weeks = [];
    const curSun = new Date(startSun);
    while (curSun <= endSun) {
      const sun = new Date(curSun);
      const mon = this.getMonday(sun);
      const monStr = this.formatDate(mon);
      const sunStr = this.formatDate(sun);
      const shortLabel = `${sun.getMonth() + 1}/${sun.getDate()}`;
      const fullLabel = `${mon.getFullYear()}/${mon.getMonth() + 1}/${mon.getDate()} ~ ${sun.getMonth() + 1}/${sun.getDate()}`;

      weeks.push({
        weekStr: monStr, // 週一字串（對齊後端點名原始資料的週次記錄）
        sunStr: sunStr,   // 週日字串
        shortLabel: shortLabel,
        label: fullLabel,
        monday: mon,
        sunday: sun
      });

      curSun.setDate(curSun.getDate() + 7);
    }
    return weeks;
  }
};

/**
 * StatsAggregator
 * 統計指標計算深模組（純資料運算、零 DOM、零樣式字串）
 * 集中管理多維點名比對索引、週次截斷、暫停週排除、KPI 計算與校園排行榜狀態機。
 */
const StatsAggregator = {
  /**
   * 聚合統計數據
   * @param {Object} params
   * @param {Object} [params.attendanceByCampus] 各校點名紀錄快取 { [campusId]: Array<{week, type, name, role}> }
   * @param {Array} [params.campuses] 校園清單 [{id, name, category, suspendedWeeks: []}]
   * @param {string} params.startDate 起始週日 (YYYY-MM-DD)
   * @param {string} params.endDate 結束週日 (YYYY-MM-DD)
   * @param {string} [params.targetCampusId='ALL'] 目標校園 ID 或 'ALL'
   * @param {boolean} [params.excludeSuspended=false] 是否排除暫停週（僅在指定個別校園時生效）
   * @returns {Object} 統計報告（純量領域模型，不包含 HTML/CSS/Chart.js 樣式）
   */
  aggregate({
    attendanceByCampus = {},
    campuses = [],
    startDate,
    endDate,
    targetCampusId = 'ALL',
    excludeSuspended = false
  } = {}) {
    // 1. 動態展開週次清單
    const weeks = Timeline.buildWeekList(startDate, endDate);

    // 2. 構建全域點名比對索引（排除服事者/家長，直接依點名紀錄篩選）
    const attMap = {};    // key: campusId|normWeek|type -> Set<name>
    const gospelMap = {}; // key: campusId|normWeek -> Set<gospelName>

    for (const [cid, recList] of Object.entries(attendanceByCampus || {})) {
      if (!Array.isArray(recList)) continue;
      for (const r of recList) {
        if (!r || r.role === '服事者/家長') continue;

        const normWeek = (r.week || '').replace(/[/\.]/g, '-').slice(0, 10);
        const key = cid + '|' + normWeek + '|' + r.type;
        if (!attMap[key]) attMap[key] = new Set();
        attMap[key].add(r.name);

        if (r.type === '出席' && (r.role === '男界朋友' || r.role === '女界朋友')) {
          const gKey = cid + '|' + normWeek;
          if (!gospelMap[gKey]) gospelMap[gKey] = new Set();
          gospelMap[gKey].add(r.name);
        }
      }
    }

    // 3. 確定目標校園與暫停週排除
    const activeCampuses = Array.isArray(campuses) ? campuses : [];
    const targetCampuses = targetCampusId === 'ALL'
      ? activeCampuses
      : activeCampuses.filter(c => c.id === targetCampusId);

    const selectedCampus = (targetCampusId !== 'ALL')
      ? (activeCampuses.find(c => c.id === targetCampusId) || null)
      : null;

    const suspendedWeeks = (selectedCampus && Array.isArray(selectedCampus.suspendedWeeks))
      ? selectedCampus.suspendedWeeks
      : [];

    const isExcluding = !!(selectedCampus && excludeSuspended && suspendedWeeks.length > 0);
    const effectiveWeeks = isExcluding
      ? weeks.filter(w => !suspendedWeeks.includes(w.weekStr))
      : weeks;
    const suspendedCount = weeks.length - effectiveWeeks.length;

    // 4. 計算走勢數列與彙總
    const labels = effectiveWeeks.map(w => w.shortLabel);
    const attendSeries = [];
    const gospelSeries = [];
    const praySeries = [];
    const outreachSeries = [];
    let totalAttendSum = 0;
    let totalGospelSum = 0;
    let latestAttendCount = 0;
    let prevAttendCount = 0;
    let latestGospelCount = 0;
    let latestWeekLabel = '';

    effectiveWeeks.forEach((w, idx) => {
      let weekAttend = 0;
      let weekGospel = 0;
      let weekPray = 0;
      let weekOutreach = 0;

      for (const c of targetCampuses) {
        const attendKey = c.id + '|' + w.weekStr + '|出席';
        weekAttend += (attMap[attendKey] || new Set()).size;

        const gKey = c.id + '|' + w.weekStr;
        weekGospel += (gospelMap[gKey] || new Set()).size;

        const prayKey = c.id + '|' + w.weekStr + '|禱告';
        weekPray += (attMap[prayKey] || new Set()).size;

        const outreachKey = c.id + '|' + w.weekStr + '|傳福音';
        weekOutreach += (attMap[outreachKey] || new Set()).size;
      }

      attendSeries.push(weekAttend);
      gospelSeries.push(weekGospel);
      praySeries.push(weekPray);
      outreachSeries.push(weekOutreach);
      totalAttendSum += weekAttend;
      totalGospelSum += weekGospel;

      if (idx === effectiveWeeks.length - 1) {
        latestAttendCount = weekAttend;
        latestGospelCount = weekGospel;
        latestWeekLabel = w.shortLabel;
      }
      if (idx === effectiveWeeks.length - 2) {
        prevAttendCount = weekAttend;
      }
    });

    // 5. 計算三大 KPI 指標（平均出席、平均福音朋友、活躍福音朋友）
    const avgAttend = effectiveWeeks.length > 0 ? (totalAttendSum / effectiveWeeks.length) : 0;
    const avgGospel = effectiveWeeks.length > 0 ? (totalGospelSum / effectiveWeeks.length) : 0;

    const gospelFriendAttendanceCounts = {}; // key: campusId|name -> 出席次數
    effectiveWeeks.forEach(w => {
      for (const c of targetCampuses) {
        const gSet = gospelMap[c.id + '|' + w.weekStr];
        if (gSet) {
          gSet.forEach(name => {
            const fKey = c.id + '|' + name;
            gospelFriendAttendanceCounts[fKey] = (gospelFriendAttendanceCounts[fKey] || 0) + 1;
          });
        }
      }
    });

    const totalFriends = Object.keys(gospelFriendAttendanceCounts).length;
    let threshold = 0;
    let activeFriendsCount = 0;
    if (totalFriends > 0) {
      threshold = totalGospelSum / totalFriends;
      activeFriendsCount = Object.values(gospelFriendAttendanceCounts).filter(cnt => cnt > threshold).length;
    }

    // 6. 計算跨校園數據排行（依全體 activeCampuses 於原始 weeks 區間統計並由高到低排序）
    const latestWeekStr = weeks.length > 0 ? weeks[weeks.length - 1].weekStr : '';
    const prevWeekStr = weeks.length > 1 ? weeks[weeks.length - 2].weekStr : '';

    const campusRankings = activeCampuses.map(c => {
      let cAttendSum = 0;
      let cGospelSum = 0;
      let cLatestAttend = 0;
      let cPrevAttend = 0;

      weeks.forEach((w, idx) => {
        const attendKey = c.id + '|' + w.weekStr + '|出席';
        const attendCount = (attMap[attendKey] || new Set()).size;
        cAttendSum += attendCount;

        const gKey = c.id + '|' + w.weekStr;
        cGospelSum += (gospelMap[gKey] || new Set()).size;

        if (idx === weeks.length - 1) cLatestAttend = attendCount;
        if (idx === weeks.length - 2) cPrevAttend = attendCount;
      });

      const cAvg = weeks.length > 0 ? (cAttendSum / weeks.length) : 0;
      const cSuspended = Array.isArray(c.suspendedWeeks) ? c.suspendedWeeks : [];
      const isLatestSuspended = latestWeekStr ? cSuspended.includes(latestWeekStr) : false;
      const isPrevSuspended = prevWeekStr ? cSuspended.includes(prevWeekStr) : false;

      let trendStatus = 'FLAT';
      const diff = cLatestAttend - cPrevAttend;

      if (isLatestSuspended) {
        trendStatus = 'THIS_WEEK_SUSPENDED';
      } else if (isPrevSuspended) {
        trendStatus = 'PREV_WEEK_SUSPENDED';
      } else if (diff > 0) {
        trendStatus = 'UP';
      } else if (diff < 0) {
        trendStatus = 'DOWN';
      } else {
        trendStatus = 'FLAT';
      }

      return {
        id: c.id,
        name: c.name,
        category: c.category || '',
        latestAttend: cLatestAttend,
        prevAttend: cPrevAttend,
        avgAttend: parseFloat(cAvg.toFixed(1)),
        formattedAvg: cAvg.toFixed(1),
        gospelTotal: cGospelSum,
        trendStatus,
        diff
      };
    });

    campusRankings.sort((a, b) => b.avgAttend - a.avgAttend);

    return {
      window: {
        startDate,
        endDate,
        totalWeeks: weeks.length,
        effectiveWeeksCount: effectiveWeeks.length,
        suspendedCount,
        isExcludingSuspended: isExcluding,
        weeks,
        effectiveWeeks
      },
      series: {
        labels,
        attend: attendSeries,
        gospel: gospelSeries,
        pray: praySeries,
        outreach: outreachSeries
      },
      latest: {
        attend: latestAttendCount,
        prevAttend: prevAttendCount,
        gospel: latestGospelCount,
        weekLabel: latestWeekLabel
      },
      kpis: {
        attendance: {
          total: totalAttendSum,
          avg: parseFloat(avgAttend.toFixed(1)),
          formattedAvg: avgAttend.toFixed(1)
        },
        gospel: {
          total: totalGospelSum,
          avg: parseFloat(avgGospel.toFixed(1)),
          formattedAvg: avgGospel.toFixed(1)
        },
        activeGospel: {
          count: activeFriendsCount,
          totalFriends: totalFriends,
          threshold: parseFloat(threshold.toFixed(1)),
          formattedThreshold: threshold.toFixed(1)
        }
      },
      campusRankings
    };
  },

  /**
   * 排序各校明細排行名單（純函式運算，不修改原陣列）
   * 
   * 排序規範：
   * 1. 走勢權重：本週暫停視為 -2000、上週暫停視為 -1000、其餘按點名差額 (最新週 - 前一週)。
   * 2. 平手打破 (Tie-breaker)：主排序數值相同時啟用同向次要排序（主升則次升、主降則次降）。
   *    - 主排序非 avgAttend 時次要比 avgAttend；主排序為 avgAttend 時次要比 latestAttend。
   *    - 若仍相同，最後以校園名稱繁體筆畫 (localeCompare zh-Hant) 做確定性平手打破。
   * 
   * @param {Array<Object>} rankings 各校明細清單
   * @param {string} [column='avgAttend'] 排序欄位 ('name' | 'latestAttend' | 'avgAttend' | 'gospelTotal' | 'trend')
   * @param {string} [direction='desc'] 排序方向 ('desc' | 'asc')
   * @returns {Array<Object>} 排序後的全新陣列
   */
  sortRankings(rankings, column = 'avgAttend', direction = 'desc') {
    if (!Array.isArray(rankings)) return [];
    const list = [...rankings];
    const mult = (direction === 'asc') ? 1 : -1;

    const getTrendScore = (item) => {
      if (!item) return 0;
      const status = item.trendStatus || '';
      if (status === 'THIS_WEEK_SUSPENDED' || status === '本週暫停' || status === '本周暫停') {
        return -2000;
      }
      if (status === 'PREV_WEEK_SUSPENDED' || status === '上週暫停') {
        return -1000;
      }
      return Number(item.diff) || 0;
    };

    return list.sort((a, b) => {
      let diff = 0;
      if (column === 'name') {
        diff = (a.name || '').localeCompare(b.name || '', 'zh-Hant');
      } else if (column === 'latestAttend') {
        diff = (Number(a.latestAttend) || 0) - (Number(b.latestAttend) || 0);
      } else if (column === 'gospelTotal') {
        diff = (Number(a.gospelTotal) || 0) - (Number(b.gospelTotal) || 0);
      } else if (column === 'trend') {
        diff = getTrendScore(a) - getTrendScore(b);
      } else {
        // 預設 avgAttend
        diff = (Number(a.avgAttend) || 0) - (Number(b.avgAttend) || 0);
      }

      if (diff !== 0) return mult * diff;

      // 主要排序數字相同時啟用次要排序：次要排序方向與主要排序保持一致 (升序即升序，降序即降序)
      // 若主排序非 avgAttend 則次要比 avgAttend；若主排序為 avgAttend 則次要比 latestAttend
      let secDiff = 0;
      if (column !== 'avgAttend') {
        secDiff = (Number(a.avgAttend) || 0) - (Number(b.avgAttend) || 0);
      } else {
        secDiff = (Number(a.latestAttend) || 0) - (Number(b.latestAttend) || 0);
      }

      if (secDiff !== 0) return mult * secDiff;

      // 若仍平手，最後以校園名稱做確定性排序
      return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
    });
  }
};
