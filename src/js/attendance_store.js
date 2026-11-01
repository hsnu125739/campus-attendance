// ==========================================
    // ===== AttendanceStore 前端深模組 =====
    // ==========================================

    /**
     * 點名狀態管理與批次同步深模組 (AttendanceStore)
     * 封裝：0ms 樂觀更新、當週 Set 索引、防抖聚合隊列、意圖保留 (保護連續點擊不被覆蓋)、
     * 指數退避探測參數 rPrime 計算、歷史點名滑動載入與頭部拼接。
     */
    class AttendanceStore {
      /**
       * @param {Object} [options]
       * @param {Object} [options.apiClient] API Client 物件（提供 batchUpdateAttendance, applyDefaultAttendance, getAttendanceHistory）
       * @param {Function} [options.onSyncStatusChange] 同步狀態計數變更通知 (pendingCount) => void
       * @param {Function} [options.onToast] 訊息提示通知 (message, type) => void
       * @param {number} [options.debounceMs=400] 防抖延遲時間（毫秒）
       * @param {number} [options.maxRetries=3] 網路錯誤重試次數
       */
      constructor(options = {}) {
        this.apiClient = options.apiClient || {};
        this.onSyncStatusChange = options.onSyncStatusChange || (() => {});
        this.onToast = options.onToast || (() => {});
        this.debounceMs = options.debounceMs ?? 400;
        this.maxRetries = options.maxRetries ?? 3;

        this.attendanceByCampus = {}; // { [campusId]: [{name, week, type, role}] }
        this.minLoadedWeek = '';
        this.currentCampusId = null;
        this.currentWeekStr = '';
        this.weekIndex = { '出席': new Set(), '禱告': new Set(), '傳福音': new Set() };
        this.syncQueue = {};
        this.batchSyncTimer = null;
        this.isBatchSyncInFlight = false;
        this.attendanceChanged = false;
        this.isLoadingHistory = false;
      }

      /**
       * 載入雲端初始點名資料與最小載入週次
       * @param {Object.<string, Array>} attendanceByCampus 各校點名紀錄集合
       * @param {string} minLoadedWeek 目前已加載的最小週次字串 (YYYY-MM-DD)
       */
      loadInitialData(attendanceByCampus, minLoadedWeek) {
        this.attendanceByCampus = attendanceByCampus || {};
        this.minLoadedWeek = minLoadedWeek || '';
        if (this.currentCampusId && this.currentWeekStr) this._rebuildWeekIndex();
      }

      /**
       * 設定當前檢視的校園與週次上下文，並自動重建索引
       * @param {string} campusId 校園 ID
       * @param {string} weekStr 週一日期字串 (YYYY-MM-DD)
       */
      setCurrentContext(campusId, weekStr) {
        this.currentCampusId = campusId;
        this.currentWeekStr = weekStr;
        this._rebuildWeekIndex();
      }

      /**
       * 內部重構當前週次的 O(1) 點名快速檢索 Set 索引
       * @private
       */
      _rebuildWeekIndex() {
        this.weekIndex = { '出席': new Set(), '禱告': new Set(), '傳福音': new Set() };
        if (!this.currentCampusId || !this.currentWeekStr) return;
        const list = this.attendanceByCampus[this.currentCampusId] || [];
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (r.week === this.currentWeekStr && this.weekIndex[r.type]) {
            this.weekIndex[r.type].add(r.name);
          }
        }
      }

      /**
       * 檢查特定成員在當前週次中是否已勾選特定點名類型
       * @param {string} name 成員姓名
       * @param {string} type 點名類型 ('出席' | '禱告' | '傳福音')
       * @returns {boolean}
       */
      isMarked(name, type) {
        return Boolean(this.weekIndex[type]?.has(name));
      }

      /**
       * 取得當前週次各項點名之統計計數
       * @returns {{ attend: number, pray: number, gospel: number }}
       */
      getWeekCounts() {
        return {
          attend: this.weekIndex['出席']?.size || 0,
          pray:   this.weekIndex['禱告']?.size || 0,
          gospel: this.weekIndex['傳福音']?.size || 0
        };
      }

      /**
       * 計算目前等待同步至後端的點名操作筆數
       * @returns {number}
       */
      getPendingCount() {
        let count = 0;
        for (const k in this.syncQueue) {
          if (this.syncQueue[k].desiredState !== this.syncQueue[k].syncedState) count++;
        }
        return count;
      }

      /**
       * 檢查本次會話中點名資料是否有發生實質變更
       * @returns {boolean}
       */
      hasChanged() { return this.attendanceChanged; }

      /**
       * 重置變更標記
       */
      resetChanged() { this.attendanceChanged = false; }

      /**
       * 取得特定校園在快取中的全部點名紀錄陣列
       * @param {string} [campusId] 校園 ID（未提供則使用當前校園）
       * @returns {Array}
       */
      getCurrentCampusAttendance(campusId) {
        const cid = campusId || this.currentCampusId;
        if (!cid) return [];
        return (this.attendanceByCampus[cid] ||= []);
      }

      /**
       * 依週次排序將紀錄插入至指定校園的點名陣列中
       * @private
       * @param {Array} list 點名紀錄清單
       * @param {Object} record 點名紀錄物件
       */
      _insertAttendanceSorted(list, record) {
        let i = list.length;
        while (i > 0 && list[i - 1].week > record.week) i--;
        if (i === list.length) list.push(record);
        else list.splice(i, 0, record);
      }

      /**
       * 精準計算大於等於目標週次（targetWeek）之所有校園點名紀錄總筆數 (rPrime)
       * 供後端指數退避定位探測使用
       * @param {string} targetWeek 目標週一日期 (YYYY-MM-DD)
       * @returns {number}
       */
      computeTargetWeekRPrime(targetWeek) {
        if (this.minLoadedWeek && this.minLoadedWeek !== '0000-00-00' && this.minLoadedWeek !== '__ALL__' && targetWeek < this.minLoadedWeek) {
          return 0;
        }
        let count = 0;
        for (const cid in this.attendanceByCampus) {
          const list = this.attendanceByCampus[cid] || [];
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].week >= targetWeek) count++;
            else break;
          }
        }
        return count;
      }

      /**
       * 點擊切換出席/禱告/傳福音狀態 (0ms 樂觀更新 + 防抖聚合隊列)
       * @param {string} name 成員姓名
       * @param {string} type 點名類型 ('出席' | '禱告' | '傳福音')
       * @param {string} [role=''] 當時身分（弟兄/姊妹/男界朋友/女界朋友）
       * @returns {{ isMarked: boolean, weekCounts: { attend: number, pray: number, gospel: number } }}
       */
      toggle(name, type, role = '') {
        const campus = this.currentCampusId, weekStr = this.currentWeekStr;
        if (!campus || !weekStr) throw new Error('未設定當前校園或週次上下文');

        const key = `${campus}|${name}|${weekStr}|${type}`;
        const list = this.getCurrentCampusAttendance(campus);

        if (!this.syncQueue[key]) {
          const currentIsOn = this.isMarked(name, type);
          this.syncQueue[key] = {
            campus, name, role: role || '', weekStr, type,
            syncedState: currentIsOn, desiredState: currentIsOn
          };
        }

        const entry = this.syncQueue[key];
        entry.desiredState = !entry.desiredState;

        if (entry.desiredState) {
          this.weekIndex[type]?.add(name);
          if (!list.some(r => r.name === name && r.week === weekStr && r.type === type)) {
            this._insertAttendanceSorted(list, { name, week: weekStr, type, role: entry.role || role });
          }
        } else {
          this.weekIndex[type]?.delete(name);
          const idx = list.findIndex(r => r.name === name && r.week === weekStr && r.type === type);
          if (idx !== -1) list.splice(idx, 1);
        }

        this.attendanceChanged = true;
        if (entry.desiredState === entry.syncedState && !this.isBatchSyncInFlight) {
          delete this.syncQueue[key];
        }

        this.onSyncStatusChange(this.getPendingCount());
        this.scheduleBatchSync();

        return { isMarked: entry.desiredState, weekCounts: this.getWeekCounts() };
      }

      /**
       * 排程防抖批次同步計時器
       * @param {boolean} [immediate=false] 是否略過防抖立即送出
       */
      scheduleBatchSync(immediate = false) {
        if (this.batchSyncTimer) {
          clearTimeout(this.batchSyncTimer);
          this.batchSyncTimer = null;
        }
        if (immediate) {
          this.flush();
          return;
        }
        this.batchSyncTimer = setTimeout(() => {
          this.batchSyncTimer = null;
          this.flush();
        }, this.debounceMs);
        this.onSyncStatusChange(this.getPendingCount());
      }

      /**
       * 立即將隊列中所有待同步的點名變更批次送至後端
       * 支援意圖保護 (若在途請求返回前使用者已再次切換，不被舊失敗還原覆蓋)
       * @returns {Promise<void>}
       */
      async flush() {
        if (this.isBatchSyncInFlight) return;
        if (this.batchSyncTimer) {
          clearTimeout(this.batchSyncTimer);
          this.batchSyncTimer = null;
        }

        const pendingKeys = Object.keys(this.syncQueue).filter(
          k => this.syncQueue[k].desiredState !== this.syncQueue[k].syncedState
        );
        if (pendingKeys.length === 0) {
          this.onSyncStatusChange(0);
          return;
        }

        const campusId = this.syncQueue[pendingKeys[0]].campus;
        const weekStr  = this.syncQueue[pendingKeys[0]].weekStr;
        const marks = [], unmarks = [], batchEntries = [];

        pendingKeys.forEach(k => {
          const item = this.syncQueue[k];
          if (item.campus !== campusId || item.weekStr !== weekStr) return;
          batchEntries.push({ key: k, targetState: item.desiredState, item });
          if (item.desiredState) marks.push({ name: item.name, role: item.role || '', type: item.type });
          else unmarks.push({ name: item.name, type: item.type });
        });

        this.isBatchSyncInFlight = true;
        this.onSyncStatusChange(this.getPendingCount());

        try {
          if (typeof this.apiClient.batchUpdateAttendance === 'function') {
            const rPrime = this.computeTargetWeekRPrime(weekStr);
            await this._retryCall(() => this.apiClient.batchUpdateAttendance(campusId, weekStr, marks, unmarks, rPrime));
          }
          batchEntries.forEach(b => {
            b.item.syncedState = b.targetState;
            if (b.item.desiredState === b.item.syncedState) delete this.syncQueue[b.key];
          });
        } catch (e) {
          this.onToast(`儲存失敗：點名紀錄未能同步 (${e.message})`, 'error');
          const list = this.getCurrentCampusAttendance(campusId);
          batchEntries.forEach(b => {
            if (b.item.desiredState !== b.targetState) return;
            b.item.desiredState = b.item.syncedState;
            if (b.item.syncedState) {
              if (this.currentCampusId === campusId && this.currentWeekStr === b.item.weekStr) {
                this.weekIndex[b.item.type]?.add(b.item.name);
              }
              if (!list.some(r => r.name === b.item.name && r.week === b.item.weekStr && r.type === b.item.type)) {
                this._insertAttendanceSorted(list, { name: b.item.name, week: b.item.weekStr, type: b.item.type, role: b.item.role || '' });
              }
            } else {
              if (this.currentCampusId === campusId && this.currentWeekStr === b.item.weekStr) {
                this.weekIndex[b.item.type]?.delete(b.item.name);
              }
              const idx = list.findIndex(r => r.name === b.item.name && r.week === b.item.weekStr && r.type === b.item.type);
              if (idx !== -1) list.splice(idx, 1);
            }
          });
        } finally {
          this.isBatchSyncInFlight = false;
          this.onSyncStatusChange(this.getPendingCount());
          if (Object.keys(this.syncQueue).some(k => this.syncQueue[k].desiredState !== this.syncQueue[k].syncedState)) {
            this.scheduleBatchSync(true);
          }
        }
      }

      /**
       * 一鍵套用預設出席名單至當前週次（覆蓋原週次紀錄並即時同步至後端）
       * @param {Array<{ name: string, type: string, role: string }>} records 欲套用之紀錄
       * @returns {Promise<void>}
       */
      async applyDefaults(records) {
        const campusId = this.currentCampusId, weekStr = this.currentWeekStr;
        if (!campusId || !weekStr) throw new Error('未設定當前校園或週次');

        const list = this.getCurrentCampusAttendance(campusId);
        const filteredList = list.filter(r => r.week !== weekStr);
        this.attendanceByCampus[campusId] = filteredList;
        this.weekIndex = { '出席': new Set(), '禱告': new Set(), '傳福音': new Set() };

        (records || []).forEach(r => {
          this.weekIndex[r.type]?.add(r.name);
          this._insertAttendanceSorted(filteredList, { name: r.name, week: weekStr, type: r.type, role: r.role || '' });
        });

        this.attendanceChanged = true;
        for (const k in this.syncQueue) {
          if (this.syncQueue[k].campus === campusId && this.syncQueue[k].weekStr === weekStr) {
            delete this.syncQueue[k];
          }
        }
        this.onSyncStatusChange(this.getPendingCount());

        if (typeof this.apiClient.applyDefaultAttendance === 'function') {
          const rPrime = this.computeTargetWeekRPrime(weekStr);
          const result = await this.apiClient.applyDefaultAttendance(campusId, weekStr, records, rPrime);
          if (result && result.success === false) throw new Error(result.error || '伺服器套用失敗');
        }
      }

      /**
       * 成員改名時連動更新記憶體快取、當週索引與待同步隊列中的姓名
       * @param {string} oldName 舊姓名
       * @param {string} newName 新姓名
       */
      renameMember(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;
        const list = this.getCurrentCampusAttendance(this.currentCampusId);
        list.forEach(r => { if (r.name === oldName) r.name = newName; });
        for (const t in this.weekIndex) {
          if (this.weekIndex[t].has(oldName)) {
            this.weekIndex[t].delete(oldName);
            this.weekIndex[t].add(newName);
          }
        }
        for (const k of Object.keys(this.syncQueue)) {
          const item = this.syncQueue[k];
          if (item.campus === this.currentCampusId && item.name === oldName) {
            item.name = newName;
            const newKey = k.replace(`|${oldName}|`, `|${newName}|`);
            if (newKey !== k) {
              this.syncQueue[newKey] = item;
              delete this.syncQueue[k];
            }
          }
        }
      }

      /**
       * 成員刪除時同步自當週索引移除
       * @param {string} name 成員姓名
       */
      removeMember(name) {
        for (const t in this.weekIndex) this.weekIndex[t].delete(name);
      }

      /**
       * 切換當前週次（若超出已快取週次範圍，自動非同步預載歷史點名紀錄）
       * @param {string} targetWeekStr 目標週一日期 (YYYY-MM-DD)
       * @returns {Promise<void>}
       */
      async setWeek(targetWeekStr) {
        if (this.minLoadedWeek && this.minLoadedWeek !== '0000-00-00' && this.minLoadedWeek !== '__ALL__' && targetWeekStr < this.minLoadedWeek) {
          const targetDate = new Date(targetWeekStr + 'T00:00:00');
          targetDate.setDate(targetDate.getDate() - 12 * 7);
          const y = targetDate.getFullYear();
          const m = String(targetDate.getMonth() + 1).padStart(2, '0');
          const d = String(targetDate.getDate()).padStart(2, '0');
          await this.ensureAttendanceRange(`${y}-${m}-${d}`);
        }
        this.currentWeekStr = targetWeekStr;
        this._rebuildWeekIndex();
      }

      /**
       * 確保指定起始週（targetStartWeek）以上的點名資料已存在快取中
       * @param {string} targetStartWeek 目標起始週一 (YYYY-MM-DD)
       * @returns {Promise<boolean>}
       */
      async ensureAttendanceRange(targetStartWeek) {
        if (this.minLoadedWeek === '0000-00-00' || this.minLoadedWeek === '__ALL__') return true;
        if (targetStartWeek && this.minLoadedWeek && targetStartWeek >= this.minLoadedWeek) return true;
        if (this.isLoadingHistory) return false;
        this.isLoadingHistory = true;

        try {
          const curDate = new Date(this.minLoadedWeek + 'T00:00:00');
          curDate.setDate(curDate.getDate() - 7);
          const y = curDate.getFullYear();
          const m = String(curDate.getMonth() + 1).padStart(2, '0');
          const d = String(curDate.getDate()).padStart(2, '0');
          const endWeek = `${y}-${m}-${d}`;

          if (typeof this.apiClient.getAttendanceHistory === 'function') {
            const result = await this.apiClient.getAttendanceHistory(targetStartWeek || '', endWeek);
            if (result && result.success && result.data) {
              const newMin = (result.data.hasMore === false || !targetStartWeek) ? '0000-00-00' : targetStartWeek;
              this.mergeAttendanceHistory(result.data.attendanceByCampus, newMin);
              return true;
            }
          }
          return false;
        } catch (e) {
          this.onToast('載入歷史紀錄失敗：' + e.message, 'error');
          return false;
        } finally {
          this.isLoadingHistory = false;
        }
      }

      /**
       * 將更早的歷史點名紀錄頭部拼接 (unshift/concat) 至快取中
       * @param {Object.<string, Array>} historyByCampus 各校歷史點名紀錄
       * @param {string} [newMinLoadedWeek] 新的最小已載入週次
       */
      mergeAttendanceHistory(historyByCampus, newMinLoadedWeek) {
        if (!historyByCampus) return;
        for (const cid in historyByCampus) {
          const hist = historyByCampus[cid] || [];
          if (hist.length === 0) continue;
          const current = this.attendanceByCampus[cid] || [];
          this.attendanceByCampus[cid] = hist.concat(current);
        }
        if (newMinLoadedWeek) this.minLoadedWeek = newMinLoadedWeek;
        this._rebuildWeekIndex();
      }

      /**
       * 內部重試輔助函式（支援指數退避重試）
       * @private
       * @param {Function} fn 非同步操作函式
       * @returns {Promise<*>}
       */
      async _retryCall(fn) {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
          try {
            const result = await fn();
            if (result && result.success === false) throw new Error(result.error || '後端回傳失敗');
            return result;
          } catch (e) {
            if (attempt === this.maxRetries) throw e;
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
          }
        }
      }
    }