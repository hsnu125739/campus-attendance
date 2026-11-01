// ===== 篩選與說明功能 =====

    /** 更新說明面板內容（點名模式 vs 編輯模式） */
    function updateHelpContent() {
      const title = document.getElementById('help-title');
      const attSection = document.getElementById('help-mode-attendance');
      const editSection = document.getElementById('help-mode-edit');
      if (!title || !attSection || !editSection) return;
      if (state.memberEditMode) {
        title.textContent = '⚙️ 編輯模式操作說明';
        attSection.style.display = 'none';
        editSection.style.display = 'block';
      } else {
        title.textContent = '💡 點名與功能說明';
        attSection.style.display = 'block';
        editSection.style.display = 'none';
      }
    }

    /** 關閉說明面板 */
    function closeHelpPanel() {
      state.helpPanelOpen = false;
      const helpPopup = document.getElementById('help-popup');
      const helpBtn = document.getElementById('btn-help');
      if (helpPopup) helpPopup.classList.remove('open');
      if (helpBtn) {
        helpBtn.classList.remove('active');
        helpBtn.blur();
      }
    }
    /** 開啟篩選面板（原地切換為搜尋框，不強制 focus 避免強彈手機鍵盤） */
    function toggleFilterPanel() {
      state.filterPanelOpen = true;
      const chips = document.getElementById('filter-chips');
      const filterBtn = document.getElementById('filter-toggle-btn');
      const searchWrap = document.getElementById('filter-search-wrap');
      if (chips) chips.classList.add('open');
      if (filterBtn) filterBtn.style.display = 'none';
      if (searchWrap) {
        searchWrap.style.display = 'flex';
        searchWrap.classList.add('panel-open');
      }

      // 若打開篩選，自動收合說明
      if (state.helpPanelOpen) {
        closeHelpPanel();
      }
    }

    /** 收合篩選面板（若搜尋框有文字則保留搜尋框，若空白則恢復為膠囊按鈕） */
    function closeFilterPanel() {
      state.filterPanelOpen = false;
      const chips = document.getElementById('filter-chips');
      const filterBtn = document.getElementById('filter-toggle-btn');
      const searchWrap = document.getElementById('filter-search-wrap');
      const searchInput = document.getElementById('filter-search-input');
      if (chips) chips.classList.remove('open');
      if (searchWrap) searchWrap.classList.remove('panel-open');
      if (searchInput) searchInput.blur();

      if (state.searchQuery) {
        if (searchWrap) {
          searchWrap.style.display = 'flex';
          searchWrap.classList.add('active-search');
        }
        if (filterBtn) filterBtn.style.display = 'none';
      } else {
        if (searchInput) searchInput.value = '';
        if (searchWrap) {
          searchWrap.style.display = 'none';
          searchWrap.classList.remove('active-search');
        }
        if (filterBtn) {
          filterBtn.style.display = '';
          filterBtn.classList.remove('panel-open');
          filterBtn.blur();
        }
      }
    }

    /** 點擊搜尋框時（若面板已收合則重新展開，並聚焦輸入框） */
    function handleFilterSearchClick() {
      if (!state.filterPanelOpen) {
        toggleFilterPanel();
      }
      const searchInput = document.getElementById('filter-search-input');
      if (searchInput && document.activeElement !== searchInput) {
        searchInput.focus();
      }
    }

    /** 即時搜尋姓名輸入處理（自動忽略空白，即時更新人員列表） */
    function handleFilterSearchInput(rawVal) {
      const q = (rawVal || '').replace(/\s+/g, '');
      state.searchQuery = q;

      const clearBtn = document.getElementById('filter-search-clear');
      const searchWrap = document.getElementById('filter-search-wrap');
      const toggleBtn = document.getElementById('filter-toggle-btn');
      if (clearBtn) clearBtn.style.display = q ? 'inline-flex' : 'none';
      if (searchWrap) searchWrap.classList.toggle('active-search', q !== '');

      // 輸入有效關鍵字時搜尋全體人員，重置身分篩選為「全部」
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      if (q) {
        state.roleFilter = '全部';
        if (toggleBtn) {
          toggleBtn.textContent = '🔍 篩選';
          toggleBtn.classList.remove('active-filter');
        }
      } else {
        const activeChip = document.querySelector(`.filter-chip[data-role="${state.roleFilter}"]`);
        if (activeChip) activeChip.classList.add('selected');
      }

      renderMembers();
    }

    /** 點擊搜尋框右側 ✕ 清除按鈕 */
    function clearFilterSearch(e) {
      if (e) e.stopPropagation();
      const searchInput = document.getElementById('filter-search-input');
      if (searchInput) searchInput.value = '';
      handleFilterSearchInput('');
      if (state.filterPanelOpen) {
        if (searchInput) searchInput.focus();
      } else {
        closeFilterPanel();
      }
    }

    /** 切換說明面板開關 */
    function toggleHelpPanel() {
      state.helpPanelOpen = !state.helpPanelOpen;
      updateHelpContent();
      const helpPopup = document.getElementById('help-popup');
      const helpBtn = document.getElementById('btn-help');
      if (helpPopup) helpPopup.classList.toggle('open', state.helpPanelOpen);
      if (helpBtn) {
        helpBtn.classList.toggle('active', state.helpPanelOpen);
        if (!state.helpPanelOpen) helpBtn.blur();
      }

      // 若打開說明，自動收合篩選面板
      if (state.helpPanelOpen && state.filterPanelOpen) {
        closeFilterPanel();
      }
    }

    /** 設定身分篩選（自動清空搜尋框並切換至指定身分） */
    function setRoleFilter(role, chipEl) {
      state.roleFilter = role;
      state.searchQuery = '';

      const searchInput = document.getElementById('filter-search-input');
      const clearBtn = document.getElementById('filter-search-clear');
      if (searchInput) searchInput.value = '';
      if (clearBtn) clearBtn.style.display = 'none';

      // 更新 chip 選中狀態
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      chipEl.classList.add('selected');

      // 篩選按鈕顯示狀態
      const toggleBtn = document.getElementById('filter-toggle-btn');
      if (role === '全部') {
        toggleBtn.textContent = '🔍 篩選';
        toggleBtn.classList.remove('active-filter');
      } else {
        toggleBtn.textContent = `🔍 ${role}`;
        toggleBtn.classList.add('active-filter');
      }

      // 關閉面板並重新渲染
      closeFilterPanel();
      renderMembers();
    }

    /** 進入校園或返回首頁時重置篩選、搜尋與說明狀態 */
    function resetFilter() {
      state.roleFilter = '全部';
      state.searchQuery = '';
      state.filterPanelOpen = false;
      state.helpPanelOpen = false;
      const searchInput = document.getElementById('filter-search-input');
      const clearBtn = document.getElementById('filter-search-clear');
      if (searchInput) searchInput.value = '';
      if (clearBtn) clearBtn.style.display = 'none';
      const helpPopup = document.getElementById('help-popup');
      const helpBtn = document.getElementById('btn-help');
      if (helpPopup) helpPopup.classList.remove('open');
      if (helpBtn) helpBtn.classList.remove('active');
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      const allChip = document.querySelector('.filter-chip[data-role="全部"]');
      if (allChip) allChip.classList.add('selected');
      const toggleBtn = document.getElementById('filter-toggle-btn');
      if (toggleBtn) {
        toggleBtn.textContent = '🔍 篩選';
        toggleBtn.classList.remove('active-filter');
      }
      closeFilterPanel();
    }

    // ===== Member List 事件委派 =====
    /**
     * 初始化人員名單點擊事件委派（單一事件監聽器處理點名打卡、編輯成員與預設值切換）
     */
    function initMemberListDelegation() {
      const container = document.getElementById('member-list');
      if (!container) return;
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.member-card');
        if (!card) return;
        const name = card.dataset.name;
        if (!name) return;
        if (state.memberEditMode) {
          const member = state.members.find(m => m.name === name);
          if (!member) return;
          const deleteBadge = e.target.closest('.delete-badge');
          if (deleteBadge) {
            confirmDelete('人位', name, () => handleDeleteMember(name));
            return;
          }

          const actionBtn = e.target.closest('.action-btn');
          if (actionBtn) {
            const type = actionBtn.dataset.type;
            if (type) {
              toggleMemberDefaultLocal(member, type);
            }

            return;
          }

          // 點擊 edit-badge 或卡片本體開啟編輯 modal（修改姓名與身分）
          openEditMemberModal(member);
        } else {
          const actionBtn = e.target.closest('.action-btn');
          if (actionBtn) {
            const type = actionBtn.dataset.type;
            if (type) {
              toggleRecord(name, type);
            }
          }
        }
      });
    }

    // ===== 篩選與說明面板點擊外部關閉（使用捕獲階段以確保任何區域點擊皆能觸發） =====
    document.addEventListener('click', (e) => {
      if (state.filterPanelOpen) {
        const filterBar = document.getElementById('filter-bar');
        if (filterBar && !filterBar.contains(e.target)) {
          closeFilterPanel();
        }
      }

      if (state.helpPanelOpen) {
        const fabGroup = document.getElementById('fab-group');
        if (fabGroup && !fabGroup.contains(e.target)) {
          state.helpPanelOpen = false;
          const helpPopup = document.getElementById('help-popup');
          const helpBtn = document.getElementById('btn-help');
          if (helpPopup) helpPopup.classList.remove('open');
          if (helpBtn) helpBtn.classList.remove('active');
        }
      }

    }, true);

    // ===== Modal 鍵盤支持 =====
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (document.getElementById('modal-add-campus').classList.contains('active')) {
          handleAddCampus();
        } else if (document.getElementById('modal-add-member').classList.contains('active')) {
          handleAddMember();
        } else if (document.getElementById('modal-edit-member').classList.contains('active')) {
          handleEditMember();
        } else if (document.getElementById('modal-rename-campus').classList.contains('active')) {
          handleRenameCampus();
        } else if (document.getElementById('modal-confirm').classList.contains('active')) {
          handleConfirm();
        }
      }

      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.active').forEach(m => {
          closeModal(m.id);
        });
      }
    });

    // 點擊 modal 背景關閉
    // 重要防護：表單類對話框（新增小排、編輯小排、新增成員、編輯成員、刪除確認等）
    // 禁止點擊背景空白關閉，必須點擊「取消」或對應按鈕，徹底杜絕誤觸與手機端偏移引發的悲劇！
    const noBackdropCloseModals = new Set([
      'modal-add-campus',
      'modal-rename-campus',
      'modal-add-member',
      'modal-edit-member',
      'modal-confirm'
    ]);

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      let downTarget = null;
      backdrop.addEventListener('pointerdown', (e) => {
        downTarget = e.target;
      });
      backdrop.addEventListener('pointercancel', () => {
        downTarget = null;
      });

      // 關鍵防護：當手指在背景遮罩（對話框外部）滑動時，完全阻止滾動手勢傳遞，徹底凍結背景畫面！
      backdrop.addEventListener('touchmove', (e) => {
        if (e.target === backdrop) {
          e.preventDefault();
        }
      }, { passive: false });

      backdrop.addEventListener('click', (e) => {
        if (noBackdropCloseModals.has(backdrop.id)) {
          downTarget = null;
          return;
        }
        if (e.target === backdrop && downTarget === backdrop) {
          closeModal(backdrop.id);
        }
        downTarget = null;
      });
    });

    // ===== 初始化 =====
    window.addEventListener('DOMContentLoaded', () => {
      initCampusListDelegation();
      initMemberListDelegation();
      if (typeof SERVER_PRELOADED_DATA !== 'undefined' && SERVER_PRELOADED_DATA && SERVER_PRELOADED_DATA.campuses) {
        // 伺服器端已預載：0 毫秒立即呈現首頁！
        applyLoadedData(SERVER_PRELOADED_DATA);
      } else {
        // 備援：單次拉取雲端全域資料
        loadInitialDataFromCloud(false);
      }
    });