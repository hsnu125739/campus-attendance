// ===== 首頁：全域資料快取與載入 =====

    /** 將後端全域資料存入前端狀態並渲染首頁（0 毫秒極速載入） */
    function applyLoadedData(data) {
      if (!data) return;
      state.campuses = data.campuses || [];
      state.archivedCampuses = data.archivedCampuses || [];
      state.membersByCampus = data.membersByCampus || {};
      if (typeof sortMemberList === 'function') {
        Object.values(state.membersByCampus).forEach(list => sortMemberList(list));
      }
      attendanceStore.loadInitialData(data.attendanceByCampus || {}, data.minLoadedWeek || '');
      renderCampuses();
    }

    /** 從雲端非同步載入或刷新全域資料 */
    async function loadInitialDataFromCloud(showFeedback = false) {
      if (showFeedback) showLoading();
      try {
        const result = await callServer('getInitialAppData');
        if (result.success) {
          applyLoadedData(result.data);

          // 若當前在點名頁面，同步刷新當前校園
          if (state.currentCampusId) {
            state.members = state.membersByCampus[state.currentCampusId] || [];
            filterAttendanceForWeek();
            renderMembers();
            updateAttendanceCount();
          }

          if (showFeedback) showToast('已從雲端同步最新資料', 'success');
        } else {
          if (showFeedback) showToast('同步失敗：' + (result.error || '未知錯誤'), 'error');
        }

      } catch (e) {
        if (showFeedback) showToast('連線失敗：' + e.message, 'error');
      } finally {
        if (showFeedback) hideLoading();
      }
    }

    /**
     * 合併從後端取得的更早歷史點名資料 (委派至 AttendanceStore 頭部拼接)
     */
    function mergeAttendanceHistory(historyByCampus, newMinLoadedWeek) {
      attendanceStore.mergeAttendanceHistory(historyByCampus, newMinLoadedWeek);
      if (state.currentCampusId) {
        renderMembers();
        updateAttendanceCount();
      }
    }

    /**
     * 確保指定起始週（targetStartWeek）以上的點名資料已存在快取中 (委派至 AttendanceStore)
     */
    async function ensureAttendanceRange(targetStartWeek) {
      showLoading();
      try {
        const ok = await attendanceStore.ensureAttendanceRange(targetStartWeek);
        if (state.currentCampusId) {
          renderMembers();
          updateAttendanceCount();
        }
        return ok;
      } finally {
        hideLoading();
      }
    }

    /** 渲染校園列表（使用 DocumentFragment 批次組裝，避免 DOM 重繪） */
    function renderCampuses() {
      const container = document.getElementById('campus-list');

      // 更新首頁底部管理按鈕群組顯示狀態
      updateCampusFooterUI();

      if (state.campuses.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">🏫</div>
            <p>尚無小排，點擊下方按鈕新增</p>
          </div>`;
        return;
      }

      const fragment = document.createDocumentFragment();

      // 依分類分組
      const groups = {};
      state.campuses.forEach(c => {
        const cat = c.category || '其他';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(c);
      });

      // 分組順序：高中 → 國中 → 社區排 → 其他
      const order = ['高中', '國中', '社區排', '其他'];
      order.forEach(cat => {
        if (!groups[cat] || groups[cat].length === 0) return;
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = cat;
        fragment.appendChild(title);
        const grid = document.createElement('div');
        grid.className = 'campus-grid';
        grid.dataset.category = cat;
        const sortedList = groups[cat].sort((a, b) => (a.sort || 0) - (b.sort || 0));
        sortedList.forEach((campus, index) => {
          const card = document.createElement('div');
          card.className = 'campus-card' + (state.campusEditMode ? ' edit-mode' : '');
          card.dataset.id = campus.id;
          card.dataset.name = campus.name;
          card.dataset.category = cat;

          // 校園名稱
          const nameEl = document.createElement('span');
          nameEl.className = 'campus-card-name';
          nameEl.textContent = campus.name;
          card.appendChild(nameEl);

          // 編輯小排按鈕
          const renameBadge = document.createElement('span');
          renameBadge.className = 'rename-badge';
          renameBadge.textContent = '✏️';
          renameBadge.title = '編輯小排';
          card.appendChild(renameBadge);

          // 刪除按鈕
          const deleteBadge = document.createElement('span');
          deleteBadge.className = 'delete-badge';
          deleteBadge.textContent = '✕';
          deleteBadge.title = '封存小排';
          card.appendChild(deleteBadge);

          // 編輯模式：左右/前後移動按鈕
          if (state.campusEditMode) {
            const reorderBar = document.createElement('div');
            reorderBar.className = 'campus-reorder-bar';

            // ◀ 前移按鈕
            const btnLeft = document.createElement('button');
            btnLeft.type = 'button';
            btnLeft.className = 'campus-reorder-btn';
            btnLeft.innerHTML = '◀';
            btnLeft.title = '往前移動一位';
            btnLeft.dataset.dir = '-1';
            if (index === 0) btnLeft.disabled = true;
            reorderBar.appendChild(btnLeft);

            // ▶ 後移按鈕
            const btnRight = document.createElement('button');
            btnRight.type = 'button';
            btnRight.className = 'campus-reorder-btn';
            btnRight.innerHTML = '▶';
            btnRight.title = '往後移動一位';
            btnRight.dataset.dir = '1';
            if (index === sortedList.length - 1) btnRight.disabled = true;
            reorderBar.appendChild(btnRight);
            card.appendChild(reorderBar);
          }

          grid.appendChild(card);
        });

        fragment.appendChild(grid);
      });

      if (container.replaceChildren) {
        container.replaceChildren(fragment);
      } else {
        container.innerHTML = '';
        container.appendChild(fragment);
      }
    }

    /** Campus List 全域事件委派（單一事件監聽，杜絕重複閉包與記憶體洩漏） */
    function initCampusListDelegation() {
      const container = document.getElementById('campus-list');
      if (!container) return;
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.campus-card');
        if (!card) return;
        const campusId = card.dataset.id;
        const campusName = card.dataset.name;
        if (!campusId) return;

        // 改名按鈕
        const renameBtn = e.target.closest('.rename-badge');
        if (renameBtn) {
          e.stopPropagation();
          openRenameCampusModal(campusId, campusName);
          return;
        }

        // 刪除/封存按鈕
        const deleteBtn = e.target.closest('.delete-badge');
        if (deleteBtn) {
          e.stopPropagation();
          confirmDelete('小排', campusName, () => handleDeleteCampus(campusId, campusName));
          return;
        }

        // 排序按鈕 (◀ 前移 / ▶ 後移)
        const reorderBtn = e.target.closest('.campus-reorder-btn');
        if (reorderBtn) {
          e.stopPropagation();
          if (reorderBtn.disabled) return;
          const dir = parseInt(reorderBtn.dataset.dir, 10);
          if (dir) moveCampus(campusId, dir);
          return;
        }

        // 點擊卡片本體：進入點名頁（非編輯模式下）
        if (!state.campusEditMode) {
          enterAttendancePage(campusId, campusName);
        }
      });
    }

    /** 本地生成校園/小排流水號 ID (CAMP_xxx 或 COMM_xxx) */
    function generateLocalCampusId(category) {
      const isComm = CampusDomain.isCommunity(category);
      const prefix = isComm ? 'COMM_' : 'CAMP_';
      let maxNum = 0;
      const allList = [...state.campuses, ...(state.archivedCampuses || [])];
      const regex = isComm ? /^COMM_(\d+)$/ : /^CAMP_(\d+)$/;
      allList.forEach(c => {
        const match = String(c.id).match(regex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      });

      return prefix + String(maxNum + 1).padStart(3, '0');
    }

    /** 在同一分類中移動校園順序（0 毫秒立即重排） */
    function moveCampus(campusId, direction) {
      const campus = state.campuses.find(c => c.id === campusId);
      if (!campus) return;
      const category = campus.category || '其他';
      const categoryCampuses = state.campuses
        .filter(c => (c.category || '其他') === category)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const idx = categoryCampuses.findIndex(c => c.id === campusId);
      if (idx === -1) return;
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= categoryCampuses.length) return;

      // 交換兩者的 sort 屬性
      const tempSort = categoryCampuses[idx].sort;
      categoryCampuses[idx].sort = categoryCampuses[targetIdx].sort;
      categoryCampuses[targetIdx].sort = tempSort;

      const prevSnapshot = captureCampusSnapshot();

      // 重新校準該分類所有校園的 sort 為連續遞增 1, 2, 3...
      categoryCampuses.sort((a, b) => (a.sort || 0) - (b.sort || 0));
      categoryCampuses.forEach((c, i) => {
        c.sort = i + 1;
      });

      renderCampuses();
      scheduleCampusSync(prevSnapshot);
    }

    /** 更新首頁底部管理按鈕群組與頂部切換列顯示狀態 */
    function updateCampusFooterUI() {
      const isEditing = !!state.campusEditMode;
      const manageBtn = document.getElementById('btn-manage-campus');
      const saveBtn = document.getElementById('btn-save-campus');
      const addBtn = document.getElementById('btn-add-campus');
      const restoreBtn = document.getElementById('btn-restore-campus');
      const topNavBar = document.getElementById('top-nav-bar');

      if (manageBtn) manageBtn.style.display = isEditing ? 'none' : '';
      if (saveBtn) saveBtn.style.display = isEditing ? '' : 'none';
      if (addBtn) addBtn.style.display = isEditing ? '' : 'none';
      if (topNavBar) topNavBar.style.display = isEditing ? 'none' : '';

      if (restoreBtn) {
        const archivedCount = (state.archivedCampuses && state.archivedCampuses.length) ? state.archivedCampuses.length : 0;
        if (isEditing && archivedCount > 0) {
          restoreBtn.style.display = '';
          restoreBtn.textContent = `📂 恢復封存小排 (${archivedCount})`;
        } else {
          restoreBtn.style.display = 'none';
        }
      }
    }

    /** 進入小排管理模式 */
    function enterCampusEditMode() {
      state.campusEditMode = true;
      state.campusesSnapshot = JSON.stringify(state.campuses);
      updateCampusFooterUI();
      renderCampuses();
    }

// ===== 小排管理同步委派 (委派至 CampusStore 前端深模組) =====

    /**
     * 建立當前啟用與封存校園的快照 (委派至 CampusStore)
     * @returns {{ campuses: Array, archivedCampuses: Array }}
     */
    function captureCampusSnapshot() {
      if (typeof campusStore !== 'undefined') {
        return campusStore.captureSnapshot(state.campuses, state.archivedCampuses);
      }
      return {
        campuses: JSON.parse(JSON.stringify(state.campuses || [])),
        archivedCampuses: JSON.parse(JSON.stringify(state.archivedCampuses || []))
      };
    }

    /**
     * 取得目前待同步的小排操作數 (委派至 CampusStore)
     * @returns {number}
     */
    function getCampusPendingCount() {
      return (typeof campusStore !== 'undefined') ? campusStore.getPendingCount() : 0;
    }

    /**
     * 排程小排清單同步 (委派至 CampusStore)
     * @param {Object} [prevSnapshot] 操作前快照
     * @param {boolean} [immediate=false] 是否立即同步
     */
    function scheduleCampusSync(prevSnapshot, immediate = false) {
      if (typeof campusStore !== 'undefined') {
        campusStore.scheduleCampusSync(prevSnapshot, immediate);
      }
    }

    /**
     * 立即送出小排清單變更至後端 (委派至 CampusStore)
     * @returns {Promise<void>}
     */
    function flushCampusSync() {
      if (typeof campusStore !== 'undefined') {
        return campusStore.flushCampusSync(state.campuses, state.archivedCampuses);
      }
    }

    /**
     * 比對兩個校園清單是否實質相等 (委派至 CampusStore)
     * @param {Array} listA
     * @param {Array} listB
     * @returns {boolean}
     */
    function areCampusListsEqual(listA, listB) {
      if (typeof campusStore !== 'undefined') {
        return campusStore.areCampusListsEqual(listA, listB);
      }
      return false;
    }

    /** 退出小排管理模式 */
    function exitCampusEditMode() {
      if (typeof campusStore !== 'undefined' && campusStore.hasPendingSync()) {
        campusStore.flushCampusSync(state.campuses, state.archivedCampuses);
      }
      state.campusEditMode = false;
      state.campusesSnapshot = null;
      updateCampusFooterUI();
      renderCampuses();
    }

    /** 新增校園（0ms 樂觀更新 + 防抖背景同步，由 CampusStore 驅動） */
    function handleAddCampus() {
      const name = document.getElementById('input-campus-name').value.trim();
      const category = getSelectedCampusCategory('add');
      if (!name) { showToast('請輸入小排名稱', 'error'); return; }
      if (!category) { showToast('請選擇分類', 'error'); return; }

      // 檢查名稱是否重複
      if (state.campuses.some(c => c.name === name)) {
        showToast('小排名稱已存在於啟用清單', 'error');
        return;
      }

      // 計算同分類最大 sort
      let maxSort = 0;
      state.campuses.forEach(c => {
        if (c.category === category && (c.sort || 0) > maxSort) {
          maxSort = c.sort;
        }
      });

      const prevSnapshot = captureCampusSnapshot();

      const newId = generateLocalCampusId(category);
      state.campuses.push({
        id: newId,
        name: name,
        category: category,
        sort: maxSort + 1,
        isArchived: false
      });

      closeModal('modal-add-campus');
      renderCampuses();
      scheduleCampusSync(prevSnapshot);
      showToast(`已新增「${name}」`, 'success');
    }

    /** 刪除校園（標記為封存，0ms 自動同步） */
    function handleDeleteCampus(campusId, name) {
      const idx = state.campuses.findIndex(c => c.id === campusId);
      if (idx === -1) return;

      const prevSnapshot = captureCampusSnapshot();

      const archivedItem = state.campuses.splice(idx, 1)[0];
      archivedItem.isArchived = true;
      if (!state.archivedCampuses) state.archivedCampuses = [];
      state.archivedCampuses.push(archivedItem);

      renderCampuses();
      scheduleCampusSync(prevSnapshot);
      showToast(`已將「${name}」移至封存`, 'success');
    }

    // ===== 恢復封存校園 =====
    /** 開啟恢復封存小排對話框 */
    function openRestoreCampusModal() {
      const container = document.getElementById('restore-campus-list');
      container.innerHTML = '';
      if (!state.archivedCampuses || state.archivedCampuses.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px;">目前無任何封存小排</div>';
        openModal('modal-restore-campus');
        return;
      }

      state.archivedCampuses.forEach(campus => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;';
        const info = document.createElement('div');
        info.innerHTML = `<span style="font-weight:600;color:#1e293b;">${campus.name}</span> <span style="font-size:12px;color:#64748b;margin-left:6px;">(${campus.category || '其他'})</span>`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = '恢復';
        btn.style.padding = '4px 12px';
        btn.onclick = () => handleRestoreCampus(campus.id, campus.name);
        item.appendChild(info);
        item.appendChild(btn);
        container.appendChild(item);
      });

      openModal('modal-restore-campus');
    }

    /**
     * 執行恢復已封存小排（0ms 樂觀更新 + 防抖背景同步，由 CampusStore 驅動）
     * @param {string} campusId 校園 ID
     * @param {string} name 校園名稱
     */
    function handleRestoreCampus(campusId, name) {
      const idx = state.archivedCampuses.findIndex(c => c.id === campusId);
      if (idx === -1) return;

      const prevSnapshot = captureCampusSnapshot();

      const restored = state.archivedCampuses.splice(idx, 1)[0];
      restored.isArchived = false;
      state.campuses.push(restored);
      state.campuses.sort((a, b) => {
        if (a.category === '高中' && b.category !== '高中') return -1;
        if (a.category !== '高中' && b.category === '高中') return 1;
        return (a.sort || 0) - (b.sort || 0);
      });

      closeModal('modal-restore-campus');
      renderCampuses();
      scheduleCampusSync(prevSnapshot);
      showToast(`已成功恢復「${name}」小排`, 'success');
    }

    // ===== 校園編輯 =====

    /** 開啟校園編輯 modal */
    function openRenameCampusModal(campusId, currentName) {
      const campus = state.campuses.find(c => c.id === campusId);
      document.getElementById('rename-campus-id').value = campusId;
      document.getElementById('input-rename-campus').value = campus ? campus.name : currentName;
      const currentCat = campus ? (campus.category || '高中') : '高中';
      setCampusCategorySelector('edit', currentCat);
      openModal('modal-rename-campus');
    }

    /** 處理校園編輯（0ms 樂觀更新 + 防抖背景同步，由 CampusStore 驅動） */
    function handleRenameCampus() {
      const campusId = document.getElementById('rename-campus-id').value;
      const newName = document.getElementById('input-rename-campus').value.trim();
      const newCategory = getSelectedCampusCategory('edit');

      if (!newName) { showToast('請輸入小排名稱', 'error'); return; }
      if (!newCategory) { showToast('請選擇小排類別', 'error'); return; }

      // 檢查新名稱是否被其他校園使用
      if (state.campuses.some(c => c.id !== campusId && c.name === newName)) {
        showToast('小排名稱已存在', 'error');
        return;
      }

      const campus = state.campuses.find(c => c.id === campusId);
      if (!campus) return;

      // 若名稱與類別皆無變更，直接關閉彈窗，避免無意義儲存
      if (campus.name === newName && (campus.category || '高中') === newCategory) {
        closeModal('modal-rename-campus');
        return;
      }

      const prevSnapshot = captureCampusSnapshot();

      const oldCategory = campus.category;
      campus.name = newName;
      if (oldCategory !== newCategory) {
        campus.category = newCategory;
        // 若跨分類移動，將其排序設為新分類的最後一位
        const sameCatCampuses = state.campuses.filter(c => c.category === newCategory && c.id !== campusId);
        const maxSort = sameCatCampuses.reduce((max, c) => Math.max(max, c.sort || 0), 0);
        campus.sort = maxSort + 1;
      }

      closeModal('modal-rename-campus');
      renderCampuses();
      scheduleCampusSync(prevSnapshot);
      showToast(`已更新「${newName}」`, 'success');
    }

    // ===== 確認動作對話框 =====
    /**
     * 開啟通用確認動作 Modal 對話框
     * @param {string} title 對話框標題
     * @param {string} messageHtml 提示 HTML 內容
     * @param {string} btnText 確認按鈕文字（預設 '確認'）
     * @param {Function} callback 使用者點擊確認後的回調函式
     */
    function confirmAction(title, messageHtml, btnText, callback) {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').innerHTML = messageHtml;
      const btn = document.getElementById('confirm-btn');
      if (btn) btn.textContent = btnText || '確認';
      state.confirmCallback = callback;
      openModal('modal-confirm');
    }

    /**
     * 開啟刪除對象確認對話框（校園或人員）
     * @param {string} type 類型 ('小排' | '人位')
     * @param {string} name 欲刪除的名稱
     * @param {Function} callback 確認後回調函式
     */
    function confirmDelete(type, name, callback) {
      let msg = `確定要刪除<span class="confirm-highlight">「${name}」</span>嗎？`;
      if (type === '小排') {
        msg += '<br><small style="color:var(--gray-500)">僅從列表移除，人員及紀錄將保留。</small>';
      } else {
        msg += '<br><small style="color:var(--gray-500)">將從人員名單移除，歷史出席紀錄將保留。</small>';
      }

      confirmAction(`確認刪除${type}`, msg, '刪除', callback);
    }

    /**
     * 處理點擊對話框「確認」按鈕
     */
    function handleConfirm() {
      closeModal('modal-confirm');
      if (state.confirmCallback) {
        state.confirmCallback();
        state.confirmCallback = null;
      }
    }

    // ===== 頁面 2：點名 =====

    /** 進入點名頁面（0 毫秒瞬間切換） */
    function enterAttendancePage(campusId, campusName) {
      state.currentCampusId = campusId;
      state.currentCampus = campusName;
      state.weekOffset = 0;
      state.memberEditMode = false;
      updateEditMemberBtn();
      resetFilter();

      // 從前端全域快取立即取出該校資料 (0 毫秒)
      state.members = state.membersByCampus[campusId] || [];
      if (typeof sortMemberList === 'function') {
        sortMemberList(state.members);
      }
      const currentCampus = state.campuses.find(c => c.id === campusId) ||
                            (state.archivedCampuses && state.archivedCampuses.find(c => c.id === campusId));
      if (currentCampus && CampusDomain.isSchool(currentCampus)) {
        state.members.forEach(m => {
          if (!m.stage || m.stage === '其他') {
            m.stage = CampusDomain.getCat(currentCampus);
          }
        });
      }

      document.getElementById('main-view-header').style.display = 'none';
      document.getElementById('page-home').style.display = 'none';
      document.getElementById('page-stats').style.display = 'none';
      document.getElementById('page-attendance').style.display = 'block';
      document.getElementById('current-campus-name').textContent = campusName;
      document.getElementById('week-label').innerHTML = getWeekLabel();
      filterAttendanceForWeek();
      renderMembers();
      updateAttendanceCount();
    }

    /** 返回首頁（0 毫秒瞬間切換） */