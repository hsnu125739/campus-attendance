// ===== 統計與趨勢頁面狀態管理（以週日代表各週區間，迄日不超過要來之週日） =====
    const statsState = {
      currentTab: 'home',
      rangeMode: 'W10',        // 'W10' | 'W20' | 'SEMESTER_CURRENT' | 'SEMESTER_SPRING' | 'SEMESTER_AUTUMN' | 'ALL' | 'CUSTOM'
      startDate: '',           // 'YYYY-MM-DD' 當前生效的起始週日
      endDate: '',             // 'YYYY-MM-DD' 當前生效的結束週日
      selectedCampusId: 'ALL',
      excludeSuspended: false, // 排除暫停週開關（預設未勾選，僅限各校模式）
      activeMetrics: {
        attend: true,
        gospel: true,
        pray: false,
        outreach: false
      },
      chartInstance: null,
      tableSort: {
        column: 'avgAttend',
        direction: 'desc'
      },
      lastReport: null
    };

    /** 取得給定日期的週一日期（委派至 Timeline 工具） */
    function getMonday(date) {
      return Timeline.getMonday(date);
    }

    /** 取得給定日期所在週的週日日期（代表該週日期，委派至 Timeline 工具） */
    function getSunday(date) {
      return Timeline.getSunday(date);
    }

    /** 取得當前週的最新週日字串（最大可選迄日，委派至 Timeline 工具） */
    function getMaxAllowedSundayStr() {
      return Timeline.getMaxAllowedSundayStr();
    }

    /** 主導航切換：首頁 (home) vs 趨勢統計 (stats) */
    function switchMainTab(tabName) {
      statsState.currentTab = tabName;
      const tabHome = document.getElementById('tab-nav-home');
      const tabStats = document.getElementById('tab-nav-stats');
      const pageHome = document.getElementById('page-home');
      const pageStats = document.getElementById('page-stats');
      const pageAttendance = document.getElementById('page-attendance');
      const mainHeader = document.getElementById('main-view-header');
      const subTitle = document.getElementById('main-app-subtitle');
      mainHeader.style.display = 'block';
      pageAttendance.style.display = 'none';
      if (tabName === 'home') {
        tabHome.classList.add('active');
        tabStats.classList.remove('active');
        pageHome.style.display = 'block';
        pageStats.style.display = 'none';
        subTitle.textContent = '選擇小排開始點名';
      } else {
        tabStats.classList.add('active');
        tabHome.classList.remove('active');
        pageHome.style.display = 'none';
        pageStats.style.display = 'block';
        subTitle.textContent = '各校數據趨勢與即時統計';

        // 第一次進入時初始化預設 10 週範圍
        if (!statsState.startDate || !statsState.endDate) {
          applyPresetRange('W10', false);
        }

        renderStatsPage();
      }
    }

    /** 依預設模式計算並設定底層 [startDate, endDate]（均為週日），並自動同步至自訂輸入框 */
    async function applyPresetRange(mode, triggerRender = true) {
      statsState.rangeMode = mode;
      const now = new Date();
      if (mode === 'W10') {
        const range = Timeline.recentWeeks(10, now);
        statsState.startDate = range.startDate;
        statsState.endDate = range.endDate;
      } else if (mode === 'W20') {
        const range = Timeline.recentWeeks(20, now);
        statsState.startDate = range.startDate;
        statsState.endDate = range.endDate;
      } else if (mode === 'SEMESTER_CURRENT' || mode === 'SEMESTER_SPRING' || mode === 'SEMESTER_AUTUMN') {
        const term = (mode === 'SEMESTER_SPRING') ? 'SPRING' : ((mode === 'SEMESTER_AUTUMN') ? 'AUTUMN' : 'CURRENT');
        const range = Timeline.semester(now.getFullYear(), term, now);
        statsState.startDate = range.startDate;
        statsState.endDate = range.endDate;
      } else if (mode === 'ALL') {
        if (attendanceStore.minLoadedWeek && attendanceStore.minLoadedWeek !== '0000-00-00' && attendanceStore.minLoadedWeek !== '__ALL__') {
          await ensureAttendanceRange('');
        }
        let earliest = Timeline.getMaxAllowedSundayStr(now);
        for (const [cid, recList] of Object.entries(attendanceStore.attendanceByCampus || {})) {
          for (const r of recList) {
            if (r.week) {
              const sunStr = Timeline.formatDate(Timeline.getSunday(r.week));
              if (sunStr < earliest) earliest = sunStr;
            }
          }
        }

        statsState.startDate = earliest;
        statsState.endDate = Timeline.getMaxAllowedSundayStr(now);
      }

      // 若指定區間早於快取最舊週，按需抓取更早歷史
      if (mode !== 'ALL' && statsState.startDate && attendanceStore.minLoadedWeek && attendanceStore.minLoadedWeek !== '0000-00-00' && attendanceStore.minLoadedWeek !== '__ALL__' && statsState.startDate < attendanceStore.minLoadedWeek) {
        await ensureAttendanceRange(statsState.startDate);
      }

      // 同步填入自訂起訖輸入框
      syncDateInputs();

      // 控制自訂列展開/隱藏
      const customBar = document.getElementById('stats-custom-range-bar');
      if (customBar) {
        customBar.style.display = (mode === 'CUSTOM' ? 'flex' : 'none');
      }

      if (triggerRender) {
        renderStatsPage();
      }
    }

    /** 將當前生效的 startDate 與 endDate (週日) 同步寫入 input，並設定 max 限制不可超過本週日 */
    function syncDateInputs() {
      const maxSunStr = getMaxAllowedSundayStr();
      const sInput = document.getElementById('stats-custom-start');
      const eInput = document.getElementById('stats-custom-end');
      if (sInput) {
        sInput.max = maxSunStr;
        if (statsState.startDate) sInput.value = statsState.startDate;
      }

      if (eInput) {
        eInput.max = maxSunStr;
        if (statsState.endDate) eInput.value = statsState.endDate;
      }
    }

    /** 切換區間下拉選單 */
    function handleStatsRangeModeChange() {
      const sel = document.getElementById('stats-range-select');
      const mode = sel.value;
      if (mode === 'CUSTOM') {
        statsState.rangeMode = 'CUSTOM';

        // 切換成自訂起訖時，自動將目前已經顯示的範圍填入輸入框！
        syncDateInputs();
        const customBar = document.getElementById('stats-custom-range-bar');
        if (customBar) customBar.style.display = 'flex';
        renderStatsPage();
      } else {
        applyPresetRange(mode, true);
      }
    }

    /** 套用自訂起訖日期（以週日為準，且限制不可超過要來之週日） */
    async function applyCustomDateRange() {
      const sInputVal = document.getElementById('stats-custom-start').value;
      const eInputVal = document.getElementById('stats-custom-end').value;
      if (!sInputVal || !eInputVal) {
        showToast('請選擇完整的開始與結束日期', 'error');
        return;
      }

      // 轉換成各自所屬週的週日
      const sSun = getSunday(sInputVal);
      let eSun = getSunday(eInputVal);
      const maxSun = getSunday(new Date());
      if (eSun > maxSun) {
        eSun = maxSun;
        showToast(`結束日期不可超過要來之週日（${formatDate(maxSun)}），已自動校準`, 'warning');
      }

      if (sSun > eSun) {
        showToast('開始日期不能晚於結束日期', 'error');
        return;
      }

      statsState.rangeMode = 'CUSTOM';
      statsState.startDate = formatDate(sSun);
      statsState.endDate = formatDate(eSun);
      syncDateInputs();
      const sel = document.getElementById('stats-range-select');
      if (sel) sel.value = 'CUSTOM';

      // 若自訂起訖超出當前快取，自動補抓歷史
      if (attendanceStore.minLoadedWeek && attendanceStore.minLoadedWeek !== '0000-00-00' && attendanceStore.minLoadedWeek !== '__ALL__' && statsState.startDate < attendanceStore.minLoadedWeek) {
        await ensureAttendanceRange(statsState.startDate);
      }

      renderStatsPage();
    }

    /** 平移時間軸窗口 (週數 delta: -5 為往前推移5週，+5 為往後推移5週) */
    async function shiftStatsWindow(weekDelta) {
      if (!statsState.startDate || !statsState.endDate) {
        await applyPresetRange('W10', false);
      }

      const shifted = Timeline.shift(statsState.startDate, statsState.endDate, weekDelta);
      statsState.startDate = shifted.startDate;
      statsState.endDate = shifted.endDate;

      // 若平移後超出快取，自動補抓歷史
      if (attendanceStore.minLoadedWeek && attendanceStore.minLoadedWeek !== '0000-00-00' && attendanceStore.minLoadedWeek !== '__ALL__' && statsState.startDate < attendanceStore.minLoadedWeek) {
        await ensureAttendanceRange(statsState.startDate);
      }

      // 自動同步到自訂日期輸入框
      syncDateInputs();
      renderStatsPage();
    }

    /** 重置時間軸窗口回到最新一週（預設 10 週） */
    function resetStatsWindowToLatest() {
      const sel = document.getElementById('stats-range-select');
      if (sel) sel.value = 'W10';
      applyPresetRange('W10', true);
    }

    /** 切換校園下拉選單 */
    function handleStatsCampusChange() {
      const sel = document.getElementById('stats-campus-select');
      if (sel) {
        statsState.selectedCampusId = sel.value;
        sel.blur();
      }
      renderStatsPage();
    }

    /** 下鑽特定校園 */
    function drilldownCampus(campusId) {
      statsState.selectedCampusId = campusId;
      const sel = document.getElementById('stats-campus-select');
      if (sel) sel.value = campusId;
      renderStatsPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** 切換指標顯示狀態 */
    function toggleStatsMetric(metricKey) {
      statsState.activeMetrics[metricKey] = !statsState.activeMetrics[metricKey];
      const chip = document.getElementById(`chip-metric-${metricKey}`);
      if (chip) {
        chip.classList.toggle('active', statsState.activeMetrics[metricKey]);
        if (metricKey === 'pray' || metricKey === 'outreach') {
          const prefix = statsState.activeMetrics[metricKey] ? '● ' : '＋ ';
          chip.querySelector('span').textContent = prefix + (metricKey === 'pray' ? '禱告' : '出訪');
        }
        chip.blur();
      }

      renderStatsPage();
    }

    /** 切換「排除暫停週」開關 */
    function toggleExcludeSuspendedWeeks() {
      const checkbox = document.getElementById('stats-exclude-suspended');
      if (checkbox) {
        statsState.excludeSuspended = !!checkbox.checked;
        checkbox.blur();
        renderStatsPage();
      }
    }

    /**
     * 底層核心：純粹依據 [startDate, endDate]（週日）動態推算所有相關週次
     */
    function computeTargetWeeksList() {
      if (!statsState.startDate || !statsState.endDate) {
        applyPresetRange('W10', false);
      }
      return Timeline.buildWeekList(statsState.startDate, statsState.endDate);
    }

    /** 依領域報告渲染各校走勢圖表 */
    function renderStatsTrendChart(report) {
      const canvas = document.getElementById('stats-trend-canvas');
      if (!canvas) return;

      const datasets = [];
      if (statsState.activeMetrics.attend) {
        datasets.push({
          label: '出席總數',
          data: report.series.attend,
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13, 148, 136, 0.08)',
          borderWidth: 2.5,
          pointBackgroundColor: '#0d9488',
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.3
        });
      }

      if (statsState.activeMetrics.gospel) {
        datasets.push({
          label: '福音朋友',
          data: report.series.gospel,
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.08)',
          borderWidth: 2.5,
          pointBackgroundColor: '#f97316',
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.3
        });
      }

      if (statsState.activeMetrics.pray) {
        datasets.push({
          label: '禱告',
          data: report.series.pray,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.05)',
          borderWidth: 2,
          borderDash: [4, 4],
          pointBackgroundColor: '#6366f1',
          pointRadius: 3,
          fill: false,
          tension: 0.3
        });
      }

      if (statsState.activeMetrics.outreach) {
        datasets.push({
          label: '出訪',
          data: report.series.outreach,
          borderColor: '#ec4899',
          backgroundColor: 'rgba(236, 72, 153, 0.05)',
          borderWidth: 2,
          borderDash: [3, 3],
          pointBackgroundColor: '#ec4899',
          pointRadius: 3,
          fill: false,
          tension: 0.3
        });
      }

      const activeCampuses = state.campuses || [];
      const chartTitle = statsState.selectedCampusId === 'ALL'
        ? '🌟 全體小排出席與參與走勢'
        : `🏫 ${(activeCampuses.find(c => c.id === statsState.selectedCampusId) || {}).name || ''} 數據走勢`;
      const titleEl = document.getElementById('stats-chart-title');
      if (titleEl) {
        titleEl.innerHTML = `${chartTitle} <span style="font-size:0.82rem; font-weight:normal; color:var(--gray-500);">(不算服事者/家長)</span>`;
      }
      if (statsState.chartInstance) {
        statsState.chartInstance.destroy();
      }

      if (typeof Chart !== 'undefined') {
        statsState.chartInstance = new Chart(canvas, {
          type: 'line',
          data: { labels: report.series.labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            devicePixelRatio: Math.max(window.devicePixelRatio || 1, 2),
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                padding: 10,
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                titleColor: '#ffffff',
                bodyColor: '#f8fafc',
                titleFont: {
                  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", sans-serif',
                  size: 13,
                  weight: '700'
                },
                bodyFont: {
                  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", sans-serif',
                  size: 12
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  precision: 0,
                  color: '#64748b',
                  font: {
                    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", sans-serif',
                    size: 11,
                    weight: '500'
                  }
                },
                grid: { color: '#f1f5f9' }
              },
              x: {
                grid: { display: false },
                ticks: {
                  maxRotation: 45,
                  color: '#64748b',
                  font: {
                    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", sans-serif',
                    size: 11,
                    weight: '600'
                  }
                }
              }
            }
          }
        });
      }
    }

    /** 依領域報告渲染各校明細排行表格（支援點擊排序） */
    function renderStatsCampusTable(report) {
      const targetReport = report || statsState.lastReport;
      if (!targetReport || !targetReport.campusRankings) return;

      const tbody = document.getElementById('stats-campus-tbody');
      if (!tbody) return;

      const sortedRankings = StatsAggregator.sortRankings(
        targetReport.campusRankings,
        statsState.tableSort.column,
        statsState.tableSort.direction
      );

      tbody.innerHTML = sortedRankings.map(r => {
        let trendBadge = '<span class="kpi-trend-flat">― 持平</span>';
        if (r.trendStatus === 'THIS_WEEK_SUSPENDED') {
          trendBadge = '<span class="kpi-trend-suspended">本週暫停</span>';
        } else if (r.trendStatus === 'PREV_WEEK_SUSPENDED') {
          trendBadge = '<span class="kpi-trend-suspended">上週暫停</span>';
        } else if (r.trendStatus === 'UP') {
          trendBadge = `<span class="kpi-trend-up">▲ +${r.diff}</span>`;
        } else if (r.trendStatus === 'DOWN') {
          trendBadge = `<span class="kpi-trend-down">▼ ${r.diff}</span>`;
        }

        const catClass = (r.category === '高中' ? 'hs' : (r.category === '國中' ? 'jh' : (r.category === '社區排' ? 'comm' : '')));
        return `
          <tr onclick="drilldownCampus('${r.id}')" title="點擊查看 ${r.name} 的詳細走勢">
            <td>
              <div class="table-campus-cell">
                <span>${r.name}</span>
                ${r.category ? `<span class="category-badge ${catClass}">${r.category}</span>` : ''}
              </div>
            </td>
            <td style="text-align:right; font-weight:700;">${r.latestAttend} 人</td>
            <td style="text-align:right; font-weight:700; color:#0d9488;">${r.avgAttend} 人</td>
            <td style="text-align:right; color:#f97316; font-weight:600;">${r.gospelTotal} 人次</td>
            <td style="text-align:center;">${trendBadge}</td>
          </tr>
        `;
      }).join('');
    }

    /** 處理各小排統計表格點擊排序（點一下降序，再點升序） */
    function handleStatsTableSort(col) {
      if (statsState.tableSort.column === col) {
        // 同一欄位：切換方向 (desc <-> asc)
        statsState.tableSort.direction = (statsState.tableSort.direction === 'desc') ? 'asc' : 'desc';
      } else {
        // 新欄位：預設由大到小 (desc)
        statsState.tableSort.column = col;
        statsState.tableSort.direction = 'desc';
      }

      updateStatsTableSortIndicators();
      renderStatsCampusTable();
    }

    /** 更新表格標題排序箭頭指示器 (▼: 降序, ▲: 升序) */
    function updateStatsTableSortIndicators() {
      const columns = ['name', 'latestAttend', 'avgAttend', 'gospelTotal', 'trend'];
      const arrow = (statsState.tableSort.direction === 'desc') ? '▼' : '▲';

      columns.forEach(col => {
        const indEl = document.getElementById('sort-ind-' + col);
        const thEl = indEl ? indEl.closest('th') : null;
        if (indEl) {
          if (col === statsState.tableSort.column) {
            indEl.textContent = arrow;
            if (thEl) thEl.classList.add('active-sort');
          } else {
            indEl.textContent = '';
            if (thEl) thEl.classList.remove('active-sort');
          }
        }
      });
    }

    /** 計算統計數據並渲染圖表、KPI 與各校明細表 */
    function renderStatsPage() {
      // 確保校園下拉選單已填入
      const campusSelect = document.getElementById('stats-campus-select');
      if (campusSelect && campusSelect.options.length <= 1) {
        const activeCampuses = state.campuses || [];
        let html = '<option value="ALL">🌟 全體小排匯總</option>';
        activeCampuses.forEach(c => {
          html += `<option value="${c.id}">${c.name} (${c.category || '一般'})</option>`;
        });

        campusSelect.innerHTML = html;
        campusSelect.value = statsState.selectedCampusId;
      }

      // 1. 調用深模組 StatsAggregator 進行純量聚合計算
      const report = StatsAggregator.aggregate({
        attendanceByCampus: attendanceStore.attendanceByCampus || {},
        campuses: state.campuses || [],
        startDate: statsState.startDate,
        endDate: statsState.endDate,
        targetCampusId: statsState.selectedCampusId,
        excludeSuspended: statsState.excludeSuspended
      });
      statsState.lastReport = report;

      // 2. 更新時間軸區間標籤（以週日代表顯示）
      const rangeLabelEl = document.getElementById('stats-window-range-label');
      if (rangeLabelEl) {
        if (report.window.weeks.length > 0) {
          const firstW = report.window.weeks[0];
          const lastW = report.window.weeks[report.window.weeks.length - 1];
          rangeLabelEl.textContent = `${firstW.shortLabel} ～ ${lastW.shortLabel} ( 共 ${report.window.totalWeeks} 週 )`;
        } else {
          rangeLabelEl.textContent = '此區間無數據';
        }
      }

      // 3. 更新【排除暫停週】Checkbox 狀態（全體時自動隱藏並停用）
      const excludeWrap = document.getElementById('stats-exclude-suspended-wrap');
      const excludeCheckbox = document.getElementById('stats-exclude-suspended');
      if (excludeWrap && excludeCheckbox) {
        if (statsState.selectedCampusId === 'ALL') {
          excludeWrap.style.display = 'none';
          excludeCheckbox.disabled = true;
        } else {
          excludeWrap.style.display = 'inline-flex';
          excludeCheckbox.disabled = false;
          excludeCheckbox.checked = !!statsState.excludeSuspended;
        }
      }

      // 4. 更新 3 大 KPI 卡片（平均出席人數、平均福音朋友、活躍福音朋友）
      // ① 平均出席人數
      const kpiAvgAttendEl = document.getElementById('kpi-avg-attend');
      const kpiAvgAttendSubEl = document.getElementById('kpi-avg-attend-sub');
      if (kpiAvgAttendEl) kpiAvgAttendEl.textContent = `${report.kpis.attendance.formattedAvg} 人/週`;
      if (kpiAvgAttendSubEl) {
        const suspendNote = report.window.isExcludingSuspended && report.window.suspendedCount > 0
          ? ` (已扣除 ${report.window.suspendedCount} 週暫停)`
          : '';
        kpiAvgAttendSubEl.textContent = `共 ${report.window.effectiveWeeksCount} 週${suspendNote} / 累計 ${report.kpis.attendance.total} 人`;
      }

      // ② 平均福音朋友
      const kpiAvgGospelEl = document.getElementById('kpi-avg-gospel');
      const kpiAvgGospelSubEl = document.getElementById('kpi-avg-gospel-sub');
      if (kpiAvgGospelEl) kpiAvgGospelEl.textContent = `${report.kpis.gospel.formattedAvg} 人/週`;
      if (kpiAvgGospelSubEl) {
        const suspendNote = report.window.isExcludingSuspended && report.window.suspendedCount > 0
          ? ` (已扣除 ${report.window.suspendedCount} 週暫停)`
          : '';
        kpiAvgGospelSubEl.textContent = `共 ${report.window.effectiveWeeksCount} 週${suspendNote} / 累計 ${report.kpis.gospel.total} 人`;
      }

      // ③ 活躍福音朋友
      const kpiActiveGospelEl = document.getElementById('kpi-active-gospel');
      const kpiActiveGospelSubEl = document.getElementById('kpi-active-gospel-sub');
      if (kpiActiveGospelEl) kpiActiveGospelEl.textContent = `${report.kpis.activeGospel.count} 人`;
      if (kpiActiveGospelSubEl) {
        const gKpi = report.kpis.activeGospel;
        kpiActiveGospelSubEl.innerHTML = `出席 > ${gKpi.formattedThreshold}次<br>(${gKpi.totalFriends}位中有${gKpi.count}位達標)`;
      }

      // 5. 渲染 Chart.js 趨勢曲線圖
      renderStatsTrendChart(report);

      // 6. 渲染各校數據明細表
      updateStatsTableSortIndicators();
      renderStatsCampusTable(report);
    }