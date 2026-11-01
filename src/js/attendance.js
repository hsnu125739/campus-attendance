// ===== 人員管理同步委派 (委派至 MemberStore 前端深模組) =====

    /**
     * 取得目前人員待同步變更筆數 (委派至 MemberStore)
     * @returns {number}
     */
    function getMemberPendingCount() {
      return (typeof memberStore !== 'undefined') ? memberStore.getPendingCount() : 0;
    }

    /**
     * 排程人員變更同步 (委派至 MemberStore)
     * @param {Object} change 變更內容 ({ type: 'add'|'modify'|'delete', name, ... })
     * @param {Function} [rollbackFn] 失敗回退回調
     * @param {boolean} [immediate=false] 是否立即同步
     */
    function scheduleMemberSync(change, rollbackFn, immediate = false) {
      if (typeof memberStore !== 'undefined') {
        memberStore.scheduleMemberSync(state.currentCampusId, change, rollbackFn, immediate);
      }
    }

    /**
     * 立即將隊列中的人員變更送至後端儲存 (委派至 MemberStore)
     * @returns {Promise<void>}
     */
    function flushMemberSync() {
      if (typeof memberStore !== 'undefined') {
        return memberStore.flushMemberSync();
      }
    }

    /**
     * 合併伺服器最新人員清單與前端隊列變更 (委派至 MemberStore)
     * @param {Array} serverMembers 伺服器回傳名單
     * @param {Array} [pendingQueue] 待同步隊列
     * @param {string} [campusId] 校園 ID
     * @returns {Array} 合併後名單
     */
    function mergeServerMembersWithPendingQueue(serverMembers, pendingQueue, campusId) {
      if (typeof memberStore !== 'undefined') {
        return memberStore.mergeServerMembersWithPendingQueue(serverMembers, pendingQueue, campusId);
      }
      return serverMembers || [];
    }

    /** 返回首頁（自動落盤背景隊列） */
    function goHome() {
      if (attendanceStore.getPendingCount() > 0) attendanceStore.flush();
      if (typeof memberStore !== 'undefined' && memberStore.getPendingCount() > 0) memberStore.flush();
      doGoHome();
    }

    /** 執行實際返回首頁導覽流程 */
    function doGoHome() {
      state.currentCampusId = null;
      state.currentCampus = null;
      state.memberEditMode = false;
      state.nameChanges = [];
      state.helpPanelOpen = false;
      const helpPopup = document.getElementById('help-popup');
      const helpBtn = document.getElementById('btn-help');
      if (helpPopup) helpPopup.classList.remove('open');
      if (helpBtn) helpBtn.classList.remove('active');
      updateEditMemberBtn();
      resetFilter();

      // 重置校園編輯模式
      if (state.campusEditMode) {
        state.campusEditMode = false;
        updateCampusFooterUI();
      }

      const mainHeader = document.getElementById('main-view-header');
      if (mainHeader) mainHeader.style.display = 'block';
      document.getElementById('page-attendance').style.display = 'none';
      switchMainTab('home');
      renderCampuses();

      if (attendanceStore.hasChanged()) {
        attendanceStore.resetChanged();
      }
    }

    /** 重新整理資料（右上角 🔄 按鈕呼叫，全量同步雲端） */
    async function loadCampusDataFull() {
      if (getPendingSaveCount() > 0) {
        showToast('請等待背景儲存完成後再重新整理', 'error');
        return;
      }

      await loadInitialDataFromCloud(true);
    }

    // 身分 → CSS class 對照表
    const ROLE_CLASS_MAP = {
      '弟兄':     'role-brother',
      '姊妹':     'role-sister',
      '男界朋友': 'role-mbro',
      '女界朋友': 'role-msis',
      '服事者/家長': 'role-server'
    };

    /** 渲染人員名單（使用 DocumentFragment 批次組裝，避免 DOM 重繪） */
    function renderMembers() {
      const container = document.getElementById('member-list');

      // 依關鍵字（優先，忽略空白）或身分篩選
      const q = state.searchQuery || '';
      const filtered = q !== ''
        ? state.members.filter(m => (m.name || '').replace(/\s+/g, '').includes(q))
        : (state.roleFilter === '全部'
            ? state.members
            : state.members.filter(m => m.role === state.roleFilter));
      if (state.members.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="grid-column: 1/-1;">
            <div class="icon">👥</div>
            <p>尚無人員，點擊右下角編輯後新增</p>
          </div>`;
        return;
      }

      if (filtered.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="grid-column: 1/-1;">
            <div class="icon">🔍</div>
            <p></p>
          </div>`;
        container.querySelector('p').textContent = q !== ''
          ? `找不到符合「${q}」的人員`
          : `目前篩選「${state.roleFilter}」無人員`;
        return;
      }

      const fragment = document.createDocumentFragment();
      filtered.forEach(member => {
        const isPresent = state.memberEditMode
          ? (member.defaults || []).includes('出席')
          : attendanceStore.isMarked(member.name, '出席');
        const isPraying = state.memberEditMode
          ? (member.defaults || []).includes('禱告')
          : attendanceStore.isMarked(member.name, '禱告');
        const isGospel  = state.memberEditMode
          ? (member.defaults || []).includes('傳福音')
          : attendanceStore.isMarked(member.name, '傳福音');
        const roleClass = ROLE_CLASS_MAP[member.role] || '';
        const card = document.createElement('div');
        card.className = 'member-card'
          + (roleClass ? ' ' + roleClass : '')
          + (isPresent ? ' present' : '')
          + (state.memberEditMode ? ' edit-mode' : '');
        card.dataset.name = member.name;

        // 姓名
        const nameEl = document.createElement('div');
        nameEl.className = 'member-name';
        nameEl.textContent = member.name;
        card.appendChild(nameEl);

        // 標籤資訊（社區排顯示於姓名下方：[原屬校園 · 學段]；校園排中若學段不同於該校則顯示於卡片右上角）
        const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                              (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
        const isComm = CampusDomain.isCommunity(currentCampus);

        if (isComm) {
          let campusName = '';
          if (member.otherGroupId) {
            const linkedCampus = state.campuses.find(c => c.id === member.otherGroupId) ||
                                 (state.archivedCampuses && state.archivedCampuses.find(c => c.id === member.otherGroupId));
            if (linkedCampus) campusName = linkedCampus.name;
          }
          let metaText = '';
          if (campusName) {
            metaText = `${campusName} · ${member.stage || '高中'}`;
          } else if (member.stage) {
            metaText = member.stage;
          }
          if (metaText) {
            const metaEl = document.createElement('div');
            metaEl.className = 'member-meta-tag';
            metaEl.textContent = metaText;
            card.appendChild(metaEl);
          }
        } else {
          // 校園排：若學段與該校分類不同，顯示在成員卡片右上角（如高中排內的國中生）
          if (member.stage && currentCampus && currentCampus.category && member.stage !== currentCampus.category) {
            const stageBadge = document.createElement('span');
            const stageClass = member.stage === '高中' ? ' hs' : '';
            stageBadge.className = 'member-stage-badge' + stageClass;
            stageBadge.textContent = member.stage;
            card.appendChild(stageBadge);
          }
        }
        if (state.memberEditMode) {
          // 編輯按鈕（左上）
          const editBadge = document.createElement('span');
          editBadge.className = 'edit-badge';
          editBadge.textContent = '✏️';
          editBadge.title = '修改姓名/身分';
          card.appendChild(editBadge);

          // 刪除按鈕（右上）
          const deleteBadge = document.createElement('span');
          deleteBadge.className = 'delete-badge';
          deleteBadge.textContent = '✕';
          deleteBadge.title = '刪除人員';
          card.appendChild(deleteBadge);
        }

        // 三個動作按鈕（正常模式點名 / 編輯模式設定預設參與）
        const actionsEl = document.createElement('div');
        actionsEl.className = 'member-actions';
        const btnDefs = [
          { cls: 'attend', type: '出席',   label: '出席', on: isPresent },
          { cls: 'pray',   type: '禱告',   label: '禱告', on: isPraying },
          { cls: 'gospel', type: '傳福音', label: '出訪', on: isGospel  },
        ];
        btnDefs.forEach(def => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'action-btn ' + def.cls + (def.on ? ' on' : '');
          btn.title = state.memberEditMode ? `設定預設「${def.label}」` : def.label;
          btn.dataset.type = def.type;
          btn.textContent = def.label;
          actionsEl.appendChild(btn);
        });

        card.appendChild(actionsEl);
        fragment.appendChild(card);
      });

      if (container.replaceChildren) {
        container.replaceChildren(fragment);
      } else {
        container.innerHTML = '';
        container.appendChild(fragment);
      }
    }

    /** 局部更新單一成員卡片的狀態，無需重新渲染整張列表 (0 毫秒極速 DOM 局部重繪) */
    function updateMemberCard(name) {
      const card = document.querySelector(`#member-list .member-card[data-name="${CSS.escape(name)}"]`);
      if (!card) return;
      const isPresent = attendanceStore.isMarked(name, '出席');
      const isPraying = attendanceStore.isMarked(name, '禱告');
      const isGospel  = attendanceStore.isMarked(name, '傳福音');
      card.classList.toggle('present', isPresent);
      const attendBtn = card.querySelector('.action-btn.attend');
      if (attendBtn) attendBtn.classList.toggle('on', isPresent);
      const prayBtn = card.querySelector('.action-btn.pray');
      if (prayBtn) prayBtn.classList.toggle('on', isPraying);
      const gospelBtn = card.querySelector('.action-btn.gospel');
      if (gospelBtn) gospelBtn.classList.toggle('on', isGospel);
    }

    // ===== 點名操作與週次切換（由 AttendanceStore 驅動） =====

    /** 點擊切換出席/禱告/傳福音 (0ms 樂觀更新 + 防抖聚合，由 AttendanceStore 驅動) */
    function toggleRecord(name, type) {
      if (isCurrentWeekSuspended()) return;
      const member = state.members.find(m => m.name === name);
      const res = attendanceStore.toggle(name, type, member ? member.role : '');
      if (type === '出席' && member && res) {
        if (res.isMarked) {
          member.count = (member.count || 0) + 1;
        } else {
          member.count = Math.max(0, (member.count || 0) - 1);
        }
      }
      updateMemberCard(name);
      updateAttendanceCount();
    }

    /** 切換週次（快取內 0ms 極速；超出快取時由 AttendanceStore 自動預載歷史） */
    async function changeWeek(delta) {
      if (attendanceStore.getPendingCount() > 0) attendanceStore.flush();
      state.weekOffset += delta;
      document.getElementById('week-label').innerHTML = getWeekLabel();

      await attendanceStore.setWeek(getCurrentWeekStr());
      renderMembers();
      updateAttendanceCount();
    }

    /** 新增人位（0ms 樂觀更新 + 防抖背景同步，由 MemberStore 驅動） */
    function handleAddMember() {
      const name = document.getElementById('input-member-name').value.trim();
      if (!name) { showToast('請輸入姓名', 'error'); return; }

      // 檢查同校是否重名
      if (state.members.some(m => m.name === name)) {
        showToast('此小排已存在相同姓名的人員', 'error');
        return;
      }

      const selectedRoleBtn = document.querySelector('#role-selector .role-btn.selected');
      if (!selectedRoleBtn) { showToast('請選擇身分', 'error'); return; }
      const role = selectedRoleBtn.dataset.role;
      const defaults = getSelectedDefaults('add-defaults-selector');

      const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                            (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
      const isComm = CampusDomain.isCommunity(currentCampus);

      let otherGroupId = '';
      if (isComm) {
        const otherGroupIdEl = document.getElementById('add-member-other-campus');
        otherGroupId = otherGroupIdEl ? otherGroupIdEl.value.trim() : '';
      }
      const stage = getSelectedStage('add');

      const newMember = {
        name: name,
        count: 0,
        role: role,
        defaults: defaults,
        otherGroupId: otherGroupId,
        stage: stage || '其他'
      };
      state.members.push(newMember);
      sortMemberList(state.members);

      if (state.currentCampusId) {
        state.membersByCampus[state.currentCampusId] = state.members;
      }

      closeModal('modal-add-member');
      renderMembers();

      const change = {
        type: 'add',
        name: name,
        role: role,
        stage: stage || '其他',
        defaults: defaults,
        otherGroupId: otherGroupId
      };
      const rollbackFn = () => {
        const idx = state.members.findIndex(m => m.name === name);
        if (idx !== -1) state.members.splice(idx, 1);
        if (state.currentCampusId) {
          state.membersByCampus[state.currentCampusId] = state.members;
        }
        if (typeof renderMembers === 'function') renderMembers();
      };
      scheduleMemberSync(change, rollbackFn);
      showToast(`已新增「${name}」`, 'success');
    }

    /** 刪除人位（0ms 樂觀更新 + 防抖背景同步，由 MemberStore 驅動） */
    function handleDeleteMember(name) {
      const idx = state.members.findIndex(m => m.name === name);
      if (idx === -1) return;
      const deletedMember = state.members.splice(idx, 1)[0];
      attendanceStore.removeMember(name);
      if (state.currentCampusId) {
        state.membersByCampus[state.currentCampusId] = state.members;
      }

      renderMembers();

      const change = { type: 'delete', name: name };
      const rollbackFn = () => {
        state.members.push(deletedMember);
        sortMemberList(state.members);
        if (state.currentCampusId) {
          state.membersByCampus[state.currentCampusId] = state.members;
        }
        if (typeof renderMembers === 'function') renderMembers();
      };
      scheduleMemberSync(change, rollbackFn);
      showToast(`已刪除「${name}」`, 'success');
    }

    // ===== 編輯人位 =====

    /** 開啟編輯人位 modal，並預填現有資料與預設參與值 */
    function openEditMemberModal(member) {
      document.getElementById('edit-member-oldname').value = member.name;
      document.getElementById('edit-member-name').value    = member.name;

      // 重置並預選身分
      const btns = document.querySelectorAll('#edit-role-selector .role-btn');
      btns.forEach(b => {
        b.classList.remove('selected');
        if (b.dataset.role === member.role) b.classList.add('selected');
      });

      // 判斷當前小排是否為社區排
      const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                            (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
      const isComm = CampusDomain.isCommunity(currentCampus);

      const campusBox = document.getElementById('edit-campus-group-box');
      if (campusBox) {
        campusBox.style.display = isComm ? 'block' : 'none';
        if (isComm) {
          populateCampusOptions('edit-member-other-campus', member.otherGroupId || '');
        }
      }

      // 學段預設
      const defaultStage = CampusDomain.isSchool(currentCampus) ? CampusDomain.getCat(currentCampus) : '高中';
      const initialStage = (!member.stage || (member.stage === '其他' && CampusDomain.isSchool(currentCampus)))
        ? defaultStage : member.stage;
      setStageSelector('edit-stage-selector', initialStage);

      // 預選預設參與值
      setSelectedDefaults('edit-defaults-selector', member.defaults || []);
      openModal('modal-edit-member');
    }

    /** 身分切換（編輯 modal 用） */
    function selectEditRole(btn) {
      document.querySelectorAll('#edit-role-selector .role-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    }

    /** 儲存人位編輯（0ms 樂觀更新 + 防抖背景同步，由 MemberStore 驅動） */
    function handleEditMember() {
      const oldName = document.getElementById('edit-member-oldname').value;
      const newName = document.getElementById('edit-member-name').value.trim();
      if (!newName) { showToast('請輸入姓名', 'error'); return; }

      // 若改名，檢查新名稱是否重複
      if (newName !== oldName && state.members.some(m => m.name === newName)) {
        showToast('此小排已存在相同姓名的人員', 'error');
        return;
      }

      const selectedRoleBtn = document.querySelector('#edit-role-selector .role-btn.selected');
      if (!selectedRoleBtn) { showToast('請選擇身分', 'error'); return; }
      const newRole = selectedRoleBtn.dataset.role;
      const member = state.members.find(m => m.name === oldName);
      if (!member) {
        closeModal('modal-edit-member');
        return;
      }
      const oldRole = member.role;

      // 檢查是否發生實質變更（若無變更，避免無意義的儲存與網路請求）
      const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                            (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
      const isComm = CampusDomain.isCommunity(currentCampus);

      const defaults = getSelectedDefaults('edit-defaults-selector');
      const stage = getSelectedStage('edit');

      let targetOtherGroupId = member.otherGroupId || '';
      if (isComm) {
        const otherGroupIdEl = document.getElementById('edit-member-other-campus');
        targetOtherGroupId = otherGroupIdEl ? otherGroupIdEl.value.trim() : '';
      } else {
        const isRenamed = (newName !== oldName);
        const isStageChanged = (stage && member.stage && member.stage !== stage);
        if (isRenamed || isStageChanged) {
          targetOtherGroupId = '';
        }
      }

      const oldDefaults = Array.isArray(member.defaults) ? member.defaults : [];
      const isDefaultsEqual = (oldDefaults.length === defaults.length) &&
        defaults.every(d => oldDefaults.includes(d));

      const hasChanged = (newName !== oldName) ||
                         (newRole !== oldRole) ||
                         ((stage || '其他') !== (member.stage || '其他')) ||
                         !isDefaultsEqual ||
                         (targetOtherGroupId !== (member.otherGroupId || ''));

      if (!hasChanged) {
        // 未發生任何變更：直接關閉彈窗，避免無意義儲存
        closeModal('modal-edit-member');
        return;
      }

      // 檢查非標準身分轉換 (降級或性別轉換)
      const isDowngrade = ['弟兄', '姊妹', '服事者/家長'].includes(oldRole) && ['男界朋友', '女界朋友'].includes(newRole);
      const isGenderChange = (['男界朋友', '弟兄'].includes(oldRole) && ['女界朋友', '姊妹'].includes(newRole)) ||
                             (['女界朋友', '姊妹'].includes(oldRole) && ['男界朋友', '弟兄'].includes(newRole));
      if (oldRole && oldRole !== newRole && (isDowngrade || isGenderChange)) {
        let reason = '';
        if (isDowngrade) reason = '受浸身分通常不可逆（弟兄/姊妹 ➔ 朋友）';
        if (isGenderChange) reason = '性別通常不應轉換';
        confirmAction(
          '⚠️ 身分變更警告',
          `您正將成員身分從「<b>${oldRole}</b>」變更為「<b>${newRole}</b>」<br><small style="color:var(--gray-500)">(${reason})</small><br><br>確定要繼續修改嗎？`,
          '確定修改',
          () => executeSaveMemberEdit(oldName, newName, newRole, defaults, stage, targetOtherGroupId)
        );
        return;
      }

      executeSaveMemberEdit(oldName, newName, newRole, defaults, stage, targetOtherGroupId);
    }

    /**
     * 執行人員編輯儲存與同步排程（樂觀更新卡片、連動改名與註冊回退）
     * @param {string} oldName 原姓名
     * @param {string} newName 新姓名
     * @param {string} newRole 新身分
     * @param {Array<string>} [preDefaults] 預設參與清單
     * @param {string} [preStage] 學段
     * @param {string} [preOtherGroupId] 關聯小排 ID
     */
    function executeSaveMemberEdit(oldName, newName, newRole, preDefaults, preStage, preOtherGroupId) {
      const currentCampus = state.campuses.find(c => c.id === state.currentCampusId) ||
                            (state.archivedCampuses && state.archivedCampuses.find(c => c.id === state.currentCampusId));
      const isComm = CampusDomain.isCommunity(currentCampus);

      const defaults = preDefaults !== undefined ? preDefaults : getSelectedDefaults('edit-defaults-selector');
      const stage = preStage !== undefined ? preStage : getSelectedStage('edit');

      const member = state.members.find(m => m.name === oldName);
      const oldMemberSnapshot = member ? {
        name: oldName,
        role: member.role,
        stage: member.stage,
        defaults: [...(member.defaults || [])],
        otherGroupId: member.otherGroupId
      } : null;

      if (member) {
        let otherGroupId = preOtherGroupId !== undefined ? preOtherGroupId : (member.otherGroupId || '');
        if (preOtherGroupId === undefined) {
          if (isComm) {
            const otherGroupIdEl = document.getElementById('edit-member-other-campus');
            otherGroupId = otherGroupIdEl ? otherGroupIdEl.value.trim() : '';
          } else {
            // 校園排：若改名或改學段，本地主動清空連結標籤 (Case 2)
            const isRenamed = (newName !== oldName);
            const isStageChanged = (stage && member.stage && member.stage !== stage);
            if (isRenamed || isStageChanged) {
              otherGroupId = '';
            }
          }
        }

        member.name = newName;
        member.role = newRole;
        member.defaults = defaults;
        member.otherGroupId = otherGroupId;
        if (stage) member.stage = stage;
      }

      if (newName !== oldName) {
        attendanceStore.renameMember(oldName, newName);
        sortMemberList(state.members);
      }

      if (state.currentCampusId) {
        state.membersByCampus[state.currentCampusId] = state.members;
      }

      closeModal('modal-edit-member');
      renderMembers();

      const change = {
        type: 'modify',
        oldName: oldName,
        name: newName,
        role: newRole,
        stage: stage || '',
        defaults: defaults,
        otherGroupId: member ? member.otherGroupId : ''
      };
      const rollbackFn = () => {
        if (oldMemberSnapshot) {
          const target = state.members.find(m => m.name === newName);
          if (target) {
            target.name = oldMemberSnapshot.name;
            target.role = oldMemberSnapshot.role;
            target.stage = oldMemberSnapshot.stage;
            target.defaults = oldMemberSnapshot.defaults;
            target.otherGroupId = oldMemberSnapshot.otherGroupId;
          }
          if (newName !== oldName) {
            attendanceStore.renameMember(newName, oldName);
            sortMemberList(state.members);
          }
          if (state.currentCampusId) {
            state.membersByCampus[state.currentCampusId] = state.members;
          }
          if (typeof renderMembers === 'function') renderMembers();
        }
      };
      scheduleMemberSync(change, rollbackFn);
      showToast(`已修改「${newName}」`, 'success');
    }

    /** 從編輯 modal 觸發刪除（先關 modal，再走確認流程） */
    function handleDeleteFromEdit() {
      const name = document.getElementById('edit-member-oldname').value;
      const currentSavedY = savedBodyScrollY;
      closeModal('modal-edit-member');
      confirmDelete('人位', name, () => handleDeleteMember(name));
      savedBodyScrollY = currentSavedY;
    }

    /** 在編輯模式下本地切換成員的預設參與值（0ms 即時反饋） */
    function toggleMemberDefaultLocal(member, type) {
      if (!Array.isArray(member.defaults)) member.defaults = [];
      const idx = member.defaults.indexOf(type);
      const wasPresent = (idx !== -1);
      if (idx !== -1) {
        member.defaults.splice(idx, 1);
      } else {
        member.defaults.push(type);
      }

      if (state.currentCampusId) {
        state.membersByCampus[state.currentCampusId] = state.members;
      }

      const defaultChange = {
        type: 'modify',
        oldName: member.name,
        name: member.name,
        role: member.role,
        stage: member.stage || '',
        defaults: [...member.defaults],
        otherGroupId: member.otherGroupId || ''
      };
      const rollbackDefaultFn = () => {
        const target = state.members.find(m => m.name === member.name);
        if (target) {
          if (wasPresent) {
            if (!target.defaults.includes(type)) target.defaults.push(type);
          } else {
            const i = target.defaults.indexOf(type);
            if (i !== -1) target.defaults.splice(i, 1);
          }
          if (state.currentCampusId) {
            state.membersByCampus[state.currentCampusId] = state.members;
          }
        }
      };
      scheduleMemberSync(defaultChange, rollbackDefaultFn);

      // 局部更新該卡片上的按鈕狀態與卡片背景亮起狀態
      const card = document.querySelector(`#member-list .member-card[data-name="${CSS.escape(member.name)}"]`);
      if (card) {
        const isPresent = member.defaults.includes('出席');
        card.classList.toggle('present', isPresent);
        const btn = card.querySelector(`.action-btn[data-type="${type}"]`);
        if (btn) {
          btn.classList.toggle('on', member.defaults.includes(type));
        }
      }
    }

    /** 切換人員編輯模式（進入編輯 / 完成退出） */
    function toggleMemberEditMode() {
      closeHelpPanel();
      state.memberEditMode = !state.memberEditMode;
      if (!state.memberEditMode && typeof flushMemberSync === 'function') {
        flushMemberSync();
      }
      updateEditMemberBtn();
      renderMembers();
    }

    /** 更新編輯按鈕與底部提示狀態 */
    function updateEditMemberBtn() {
      const btn = document.getElementById('btn-edit-members');
      const fabAdd = document.getElementById('fab-add-member');
      const fabApply = document.getElementById('btn-apply-defaults');
      const fabHint = document.getElementById('fab-edit-hint');
      if (state.memberEditMode) {
        btn.textContent = '✅';
        btn.title = '完成編輯';
        btn.classList.add('editing');
        if (fabAdd) fabAdd.classList.add('visible');
        if (fabApply) fabApply.style.display = 'none';
        if (fabHint) fabHint.style.display = 'flex';
      } else {
        btn.textContent = '✏️';
        btn.title = '編輯人員';
        btn.classList.remove('editing');
        btn.blur();
        if (fabAdd) fabAdd.classList.remove('visible');
        if (fabApply) fabApply.style.display = 'flex';
        if (fabHint) fabHint.style.display = 'none';
      }

      updateHelpContent();
      updateSuspensionUI();
    }

    // ===== 一鍵套用預設參與名單 =====

    /** 點擊「⚡ 套用預設」按鈕 */
    function handleApplyDefaultsClick() {
      if (isCurrentWeekSuspended()) {
        showToast('本週小排已暫停，無法套用預設名單', 'error');
        return;
      }

      if (getPendingSaveCount() > 0) {
        showToast('請等待背景儲存完成後再套用預設', 'error');
        return;
      }

      // 檢查當前週次是否已有點名紀錄
      const counts = attendanceStore.getWeekCounts();
      const hasRecords = counts.attend > 0 || counts.pray > 0 || counts.gospel > 0;
      if (!hasRecords) {
        // 當週全空，直接套用
        applyDefaultsConfirmed();
      } else {
        // 當週已有紀錄，提示覆蓋確認
        confirmAction(
          '確認覆蓋點名紀錄',
          '本週已有部分點名紀錄，確定要<span class="confirm-highlight">覆蓋現有紀錄</span>並套用預設參與名單嗎？<br><small style="color:var(--gray-500)">現有紀錄將被預設名單取代。</small>',
          '覆蓋套用',
          applyDefaultsConfirmed
        );
      }
    }

    /** 執行套用預設參與名單 */
    async function applyDefaultsConfirmed() {
      const weekStr = getCurrentWeekStr();
      const campusId = state.currentCampusId;

      // 整理要套用的新紀錄清單
      const newRecords = [];
      state.members.forEach(member => {
        if (Array.isArray(member.defaults)) {
          member.defaults.forEach(type => {
            if (['出席', '禱告', '傳福音'].includes(type)) {
              newRecords.push({ name: member.name, type: type, role: member.role || '' });
            }
          });
        }
      });

      // ① 立即樂觀更新前端快取與 UI (0ms 即時反饋)
      const savePromise = attendanceStore.applyDefaults(newRecords);
      renderMembers();
      updateAttendanceCount();
      showToast('已套用預設名單', 'success');

      // ② 背景等待後端批次寫回
      showLoading();
      try {
        await savePromise;
      } catch (e) {
        showToast('套用失敗：' + e.message, 'error');
        await loadCampusDataFull();
      } finally {
        hideLoading();
      }
    }