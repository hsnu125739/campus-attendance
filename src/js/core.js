    // ===== 伺服器端預載資料 (Server-side Injected Data) =====
    // SERVER_PRELOADED_DATA 由宿主 HTML 在全域預先注入（若未定義則預設為 null）
    if (typeof SERVER_PRELOADED_DATA === 'undefined') {
      var SERVER_PRELOADED_DATA = null;
    }

    // ===== 應用程式狀態 =====
    const state = {
      campuses: [],           // [{id, name, category, sort}]
      archivedCampuses: [],   // [{id, name, category, sort, isArchived}]
      campusesSnapshot: null, // 校園編輯模式快照 (JSON string)
      membersByCampus: {},    // { [campusId]: [{name, count, role, defaults: [...]}, ...] } 全校人員快取
      currentCampusId: null,  // 當前選中的校園 ID（用於後端呼叫）
      currentCampus: null,    // 當前選中的校園名稱（用於顯示）
      members: [],            // 當前選中校園的人員名單
      membersSnapshot: null,  // 人員編輯模式快照 (JSON string)
      nameChanges: [],        // 編輯模式中的改名歷程 [{oldName, newName}]
      weekOffset: 0,          // 0=本週, -1=上週, 1=下週
      campusEditMode: false,  // 校園編輯模式
      memberEditMode: false,  // 人員編輯模式
      roleFilter: '全部',     // 身分篩選（'全部' = 不篩選）
      searchQuery: '',        // 姓名搜尋關鍵字（已忽略空白）
      filterPanelOpen: false, // 篩選面板開關狀態
      helpPanelOpen: false,   // 說明面板開關狀態
      confirmCallback: null   // 確認對話框的回調函式
    };

    // ===== 校園與分類領域規則 =====
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

    // ===== 工具函式 =====

    /** 顯示 loading */
    function showLoading() {
      document.getElementById('loading').classList.add('active');
    }

    /** 隱藏 loading */
    function hideLoading() {
      document.getElementById('loading').classList.remove('active');
    }

    /** 顯示 toast 通知 */
    function showToast(message, type = '') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast' + (type ? ' ' + type : '');
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    let savedBodyScrollY = 0;

    /** 開啟 modal */
    function openModal(id) {
      if (!document.body.classList.contains('modal-open')) {
        savedBodyScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
        document.body.style.top = `-${savedBodyScrollY}px`;
        document.body.classList.add('modal-open');
      }

      const modalEl = document.getElementById(id);
      if (modalEl) modalEl.classList.add('active');

      // 重置身分與預設值選擇器
      if (id === 'modal-add-member') {
        document.querySelectorAll('#role-selector .role-btn').forEach(b => b.classList.remove('selected'));
        setSelectedDefaults('add-defaults-selector', []);

        const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                              (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
        const isComm = CampusDomain.isCommunity(currentCampus);

        const campusBox = document.getElementById('add-campus-group-box');
        if (campusBox) {
          campusBox.style.display = isComm ? 'block' : 'none';
          if (isComm) {
            populateCampusOptions('add-member-other-campus', '');
          }
        }

        const defaultStage = CampusDomain.isSchool(currentCampus) ? CampusDomain.getCat(currentCampus) : '高中';
        setStageSelector('add-stage-selector', defaultStage);
      }

      // 重置新增校園對話框狀態
      if (id === 'modal-add-campus') {
        const nameInput = document.getElementById('input-campus-name');
        if (nameInput) nameInput.value = '';
        setCampusCategorySelector('add', '高中');
      }

      // 自動聚焦第一個可見 input（僅限非觸控裝置，避免手機鍵盤無預警彈出造成畫面劇烈位移）
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch) {
        const input = document.getElementById(id).querySelector('input:not([type="hidden"])');
        if (input) setTimeout(() => input.focus(), 100);
      }
    }

    /** 設定特定 category-selector 的選中狀態 */
    function setCampusCategorySelector(modalType, categoryValue) {
      const containerId = (modalType === 'add') ? 'add-campus-category-selector' : 'edit-campus-category-selector';
      const container = document.getElementById(containerId);
      if (!container) return;
      const val = categoryValue || '高中';
      container.querySelectorAll('.category-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.cat === val);
      });
    }

    /** 選擇小排類別按鈕 */
    function selectCampusCategory(modalType, category) {
      setCampusCategorySelector(modalType, category);
    }

    /** 取得目前選中的小排類別 */
    function getSelectedCampusCategory(modalType) {
      const containerId = (modalType === 'add') ? 'add-campus-category-selector' : 'edit-campus-category-selector';
      const container = document.getElementById(containerId);
      if (!container) return '高中';
      const selected = container.querySelector('.category-btn.selected');
      return selected ? selected.dataset.cat : '高中';
    }

    /** 填充所屬校園下拉選單（僅列出國中與高中校園） */
    function populateCampusOptions(selectId, selectedValue) {
      const select = document.getElementById(selectId);
      if (!select) return;
      select.innerHTML = '<option value="">無 / 其他</option>';
      const schoolCampuses = state.campuses.filter(c => CampusDomain.isSchool(c));
      schoolCampuses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.category})`;
        if (c.id === selectedValue) opt.selected = true;
        select.appendChild(opt);
      });
    }

    /** 設定特定 stage-selector 的選中狀態 */
    function setStageSelector(containerId, stageValue) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const val = stageValue || '其他';
      container.querySelectorAll('.stage-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.stage === val);
      });
    }

    /** 選擇學段按鈕 */
    function selectStage(modalType, stage) {
      const containerId = (modalType === 'add') ? 'add-stage-selector' : 'edit-stage-selector';
      setStageSelector(containerId, stage);
    }

    /** 取得目前選中的學段 */
    function getSelectedStage(modalType) {
      const containerId = (modalType === 'add') ? 'add-stage-selector' : 'edit-stage-selector';
      const container = document.getElementById(containerId);
      if (!container) return '其他';
      const selected = container.querySelector('.stage-btn.selected');
      return selected ? selected.dataset.stage : '其他';
    }

    /** 在 Modal 中切換所屬校園時，自動帶入該校園的分類作為學段預設值 */
    function handleSelectCampusInModal(modalType) {
      const selectId = (modalType === 'add') ? 'add-member-other-campus' : 'edit-member-other-campus';
      const select = document.getElementById(selectId);
      if (!select) return;
      const cid = select.value;
      if (cid) {
        const campus = state.campuses.find(c => c.id === cid) ||
                       (state.archivedCampuses && state.archivedCampuses.find(c => c.id === cid));
        if (campus && CampusDomain.isSchool(campus)) {
          const containerId = (modalType === 'add') ? 'add-stage-selector' : 'edit-stage-selector';
          setStageSelector(containerId, CampusDomain.getCat(campus));
        }
      }
    }

    /** 選擇身分 */
    function selectRole(btn) {
      document.querySelectorAll('#role-selector .role-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    }

    /** 切換 Modal 內的預設參與選項 */
    function toggleDefaultSelection(btn) {
      btn.classList.toggle('selected');
    }

    /** 取得目前選中的預設參與選項清單 */
    function getSelectedDefaults(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return [];
      const selected = [];
      container.querySelectorAll('.default-toggle-btn.selected').forEach(btn => {
        selected.push(btn.dataset.type);
      });
      return selected;
    }

    /** 設定預設參與選項按鈕的選中狀態 */
    function setSelectedDefaults(containerId, defaultsList) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const list = Array.isArray(defaultsList) ? defaultsList : [];
      container.querySelectorAll('.default-toggle-btn').forEach(btn => {
        btn.classList.toggle('selected', list.includes(btn.dataset.type));
      });
    }

    /** 關閉 modal */
    function closeModal(id) {
      const modalEl = document.getElementById(id);
      if (modalEl) {
        modalEl.classList.remove('active');
      }

      // 若所有 modal 皆已關閉，恢復 body 滾動狀態與捲動位置
      if (!document.querySelector('.modal-backdrop.active')) {
        const restoreY = savedBodyScrollY;
        document.body.classList.remove('modal-open');
        document.body.style.top = '';
        window.scrollTo(0, restoreY);
      }

      // 清空 input
      if (modalEl) {
        const inputs = modalEl.querySelectorAll('input, select');
        inputs.forEach(el => {
          if (el.tagName === 'SELECT') el.selectedIndex = 0;
          else el.value = '';
        });
      }
    }

    /** 取得某週的週一日期 (依 weekOffset) */
    function getWeekMonday(offset) {
      const now = new Date();
      const day = now.getDay(); // 0=Sun, 1=Mon, ...
      const diff = day === 0 ? -6 : 1 - day; // 調整到本週一
      const monday = new Date(now);
      monday.setDate(now.getDate() + diff + (offset * 7));
      monday.setHours(0, 0, 0, 0);
      return monday;
    }

    /** 格式化日期為 YYYY-MM-DD */
    function formatDate(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    /** 格式化日期為顯示用 M/D */
    function formatDateDisplay(date) {
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }

    /** 取得當前選擇的週次字串（週一日期） */
    function getCurrentWeekStr() {
      return formatDate(getWeekMonday(state.weekOffset));
    }

    /** 設定當前校園與週次快取索引 (委派至 AttendanceStore 極速建構) */
    function filterAttendanceForWeek() {
      attendanceStore.setCurrentContext(state.currentCampusId, getCurrentWeekStr());
    }

    /** 取得週次顯示標籤 */
    function getWeekLabel() {
      const monday = getWeekMonday(state.weekOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      let tag = '';
      if (state.weekOffset === 0) tag = '<span class="week-tag">本週</span>';
      else if (state.weekOffset === -1) tag = '<span class="week-tag">上週</span>';
      else if (state.weekOffset === 1) tag = '<span class="week-tag">下週</span>';
      return `${tag}${formatDateDisplay(monday)} ~ ${formatDateDisplay(sunday)}`;
    }

    /** 更新統計顯示 (委派至 AttendanceStore O(1) 統計) */
    function updateAttendanceCount() {
      const counts = attendanceStore.getWeekCounts();
      document.getElementById('attendance-count').textContent =
        `出席${counts.attend} / 禱告${counts.pray} / 福音${counts.gospel}`;
      updateSuspensionUI();
    }

    // ===== 小排暫停狀態管理 =====

    /** 判斷當前校園於當前週次是否處於「小排暫停」狀態 */
    function isCurrentWeekSuspended() {
      if (!state.currentCampusId) return false;
      const campus = (state.campuses || []).find(c => c.id === state.currentCampusId);
      if (!campus || !Array.isArray(campus.suspendedWeeks)) return false;
      const currentWeek = getCurrentWeekStr();
      return campus.suspendedWeeks.includes(currentWeek);
    }

    /** 更新「本週小排暫停」按鈕、成員卡片與套用預設按鈕之狀態 */
    function updateSuspensionUI() {
      const bar = document.getElementById('suspend-bar');
      const btn = document.getElementById('btn-suspend');
      const memberList = document.getElementById('member-list');
      const fabApply = document.getElementById('btn-apply-defaults');
      if (!bar || !btn) return;

      // 1. 人員編輯模式下隱藏小排暫停按鈕
      if (state.memberEditMode) {
        bar.style.display = 'none';
        if (memberList) memberList.classList.remove('suspended');
        return;
      }
      bar.style.display = 'flex';

      const isSuspended = isCurrentWeekSuspended();
      const counts = attendanceStore.getWeekCounts();
      const hasRecords = counts.attend > 0 || counts.pray > 0 || counts.gospel > 0;

      if (isSuspended) {
        // 狀態 B：已確認暫停
        btn.classList.add('is-suspended');
        btn.classList.remove('disabled');
        btn.innerHTML = '🚫 本週小排已暫停（點擊恢復點名）';
        btn.title = '點擊以取消小排暫停並恢復點名';

        if (memberList) memberList.classList.add('suspended');
        if (fabApply) {
          fabApply.classList.add('disabled');
          fabApply.setAttribute('aria-disabled', 'true');
        }
      } else {
        // 狀態 A：未暫停
        btn.classList.remove('is-suspended');
        btn.innerHTML = '⏸️ 本週小排暫停';

        if (hasRecords) {
          btn.classList.add('disabled');
          btn.title = '本週已有部分點名，請先清空點名紀錄才能設為暫停';
        } else {
          btn.classList.remove('disabled');
          btn.title = '設定本週小排暫停';
        }

        if (memberList) memberList.classList.remove('suspended');
        if (fabApply && !state.memberEditMode) {
          fabApply.classList.remove('disabled');
          fabApply.removeAttribute('aria-disabled');
        }
      }
    }

    /** 點擊【本週小排暫停】按鈕 */
    async function handleToggleSuspendClick() {
      if (!state.currentCampusId) return;

      const campusId = state.currentCampusId;
      const weekStr = getCurrentWeekStr();
      const campus = (state.campuses || []).find(c => c.id === campusId);
      if (!campus) return;

      if (!Array.isArray(campus.suspendedWeeks)) {
        campus.suspendedWeeks = [];
      }

      const currentlySuspended = campus.suspendedWeeks.includes(weekStr);
      const counts = attendanceStore.getWeekCounts();
      const hasRecords = counts.attend > 0 || counts.pray > 0 || counts.gospel > 0;

      // 防呆：若未暫停且已有紀錄，提示使用者清空
      if (!currentlySuspended && hasRecords) {
        showToast('本週已有部分點名，請先清空點名紀錄才能設為暫停', 'error');
        return;
      }

      if (getPendingSaveCount() > 0) {
        showToast('請等待背景點名儲存完成後再切換', 'error');
        return;
      }

      const targetSuspended = !currentlySuspended;

      // 樂觀更新 (Optimistic UI Update)
      if (targetSuspended) {
        if (!campus.suspendedWeeks.includes(weekStr)) {
          campus.suspendedWeeks.push(weekStr);
          campus.suspendedWeeks.sort();
        }
      } else {
        campus.suspendedWeeks = campus.suspendedWeeks.filter(w => w !== weekStr);
      }
      updateSuspensionUI();

      try {
        const res = await callServer('toggleCampusSuspension', campusId, weekStr, targetSuspended);
        if (res.success) {
          if (Array.isArray(res.suspendedWeeks)) {
            campus.suspendedWeeks = res.suspendedWeeks;
          }
          showToast(targetSuspended ? '已設定本週小排暫停' : '已取消本週小排暫停，恢復正常點名', 'success');
        } else {
          throw new Error(res.error || '伺服器儲存失敗');
        }
      } catch (e) {
        // Rollback
        if (currentlySuspended) {
          if (!campus.suspendedWeeks.includes(weekStr)) {
            campus.suspendedWeeks.push(weekStr);
            campus.suspendedWeeks.sort();
          }
        } else {
          campus.suspendedWeeks = campus.suspendedWeeks.filter(w => w !== weekStr);
        }
        updateSuspensionUI();
        showToast('操作失敗：' + e.message, 'error');
      }
    }

    // ===== google.script.run 的 Promise 包裝 =====
    /**
     * 包裝 Google Apps Script 非同步 RPC 呼叫為標準 Promise
     * @param {string} functionName 後端公開函式名稱
     * @param {...*} args 傳遞給後端函式之參數
     * @returns {Promise<*>}
     */
    function callServer(functionName, ...args) {
      return new Promise((resolve, reject) => {
        if (typeof google === 'undefined' || !google.script || !google.script.run) {
          reject(new Error('google.script.run 未定義'));
          return;
        }

        const runner = google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler((err) => {
            const msg = (err && err.message) ? err.message : String(err || '未知錯誤');
            reject(new Error(msg));
          });

        if (typeof runner[functionName] !== 'function') {
          reject(new Error(`後端函式「${functionName}」不存在。請確認已將 Code.gs 複製並在 Apps Script 部署為「新版本」！`));
          return;
        }

        runner[functionName](...args);
      });
    }

    // ===== AttendanceStore 前端深模組實例化 =====
    const attendanceStore = new AttendanceStore({
      apiClient: {
        batchUpdateAttendance: (...args) => callServer('batchUpdateAttendance', ...args),
        applyDefaultAttendance: (...args) => callServer('applyDefaultAttendance', ...args),
        getAttendanceHistory: (startWeek, endWeek) => callServer('getAttendanceHistory', '', startWeek, endWeek)
      },
      onSyncStatusChange: () => {
        updatePendingSaveIndicator();
      },
      onToast: (msg, type) => {
        showToast(msg, type);
      },
      debounceMs: 400,
      maxRetries: 3
    });

    // ===== MemberStore 前端深模組實例化 =====
    const memberStore = new MemberStore({
      apiClient: {
        applyMemberChanges: (...args) => callServer('applyMemberChanges', ...args)
      },
      getCurrentCampusId: () => state.currentCampusId,
      onSyncStatusChange: () => {
        updatePendingSaveIndicator();
      },
      onToast: (msg, type) => {
        showToast(msg, type);
      },
      onSuccess: (campusId, mergedMembers, affectedMembers) => {
        if (Array.isArray(mergedMembers)) {
          state.membersByCampus[campusId] = mergedMembers;
          if (state.currentCampusId === campusId) {
            state.members = mergedMembers;
            if (typeof renderMembers === 'function') renderMembers();
          }
        }
        if (Array.isArray(affectedMembers)) {
          affectedMembers.forEach(aff => {
            const list = state.membersByCampus[aff.campusId];
            if (Array.isArray(list)) {
              const target = list.find(m => m.name === aff.name);
              if (target) target.otherGroupId = aff.otherGroupId;
            }
          });
        }
      },
      onRollback: (campusId) => {
        if (state.currentCampusId === campusId) {
          state.membersByCampus[campusId] = state.members;
          if (typeof renderMembers === 'function') renderMembers();
        }
      },
      debounceMs: 400
    });

    // ===== CampusStore 前端深模組實例化 =====
    const campusStore = new CampusStore({
      apiClient: {
        applyCampusChanges: (...args) => callServer('applyCampusChanges', ...args)
      },
      getCurrentCampuses: () => ({
        campuses: state.campuses || [],
        archivedCampuses: state.archivedCampuses || []
      }),
      onSyncStatusChange: () => {
        updatePendingSaveIndicator();
      },
      onToast: (msg, type) => {
        showToast(msg, type);
      },
      onRollback: (rollback) => {
        if (rollback) {
          state.campuses = rollback.campuses;
          state.archivedCampuses = rollback.archivedCampuses;
          if (typeof renderCampuses === 'function') renderCampuses();
        }
      },
      debounceMs: 400
    });

    /** 計算目前所有正在防抖等待或背景儲存中的操作數 */
    function getPendingSaveCount() {
      let count = 0;
      if (typeof attendanceStore !== 'undefined') count += attendanceStore.getPendingCount();
      if (typeof memberStore !== 'undefined') count += memberStore.getPendingCount();
      else if (typeof getMemberPendingCount === 'function') count += getMemberPendingCount();
      if (typeof campusStore !== 'undefined') count += campusStore.getPendingCount();
      else if (typeof getCampusPendingCount === 'function') count += getCampusPendingCount();
      return count;
    }

    /** 更新背景儲存計數器指示燈 */
    function updatePendingSaveIndicator() {
      const count = getPendingSaveCount();
      let indicator = document.getElementById('pending-save');
      if (count > 0) {
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.id = 'pending-save';
          document.body.appendChild(indicator);
        }

        indicator.textContent = `儲存中 (${count})...`;
        indicator.style.display = 'block';
      } else if (indicator) {
        indicator.style.display = 'none';
      }
    }

    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { CampusDomain, state };
    }