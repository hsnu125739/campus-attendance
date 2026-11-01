// ==========================================
// ===== MemberStore 前端深模組 =====
// ==========================================

/**
 * 人員清單標準排序函式（與後端 SpreadsheetRepository 規範 100% 一致）
 * 規則：出席次數降序 (count 較高者在先)；若次數相同則依姓名字串筆畫/語系升序 (a.name.localeCompare(b.name))
 * @param {Array} list 人員陣列
 * @returns {Array} 排序後的人員陣列原址參照
 */
function sortMemberList(list) {
  if (!Array.isArray(list)) return list;
  return list.sort((a, b) => {
    const countA = Number(a ? a.count : 0) || 0;
    const countB = Number(b ? b.count : 0) || 0;
    if (countB !== countA) return countB - countA;
    const nameA = (a && a.name) ? String(a.name) : '';
    const nameB = (b && b.name) ? String(b.name) : '';
    return nameA.localeCompare(nameB);
  });
}

/**
 * 成員管理 0ms 樂觀自動同步與回退管線深模組
 * 封裝隊列、防抖計時器、在途請求鎖、記憶體快照合併、改名聚合與失敗回退。
 */
class MemberStore {
  static sortMembers(list) {
    return sortMemberList(list);
  }
  /**
   * @param {Object} [options]
   * @param {Object} [options.apiClient] API Client 物件，需提供 applyMemberChanges(campusId, { changes })
   * @param {Function} [options.onSyncStatusChange] 同步狀態計數變更通知 (pendingCount) => void
   * @param {Function} [options.onToast] 提示通知 (msg, type) => void
   * @param {Function} [options.onSuccess] 儲存成功回調 (campusId, mergedMembers, affectedMembers, warnings) => void
   * @param {Function} [options.onRollback] 失敗回退回調 (campusId, batch, error) => void
   * @param {Function} [options.getCurrentCampusId] 取得當前校園 ID 的回調 () => string
   * @param {number} [options.debounceMs=400] 防抖時間（毫秒）
   */
  constructor(options = {}) {
    this.apiClient = options.apiClient || {};
    this.onSyncStatusChange = options.onSyncStatusChange || (() => {});
    this.onToast = options.onToast || (() => {});
    this.onSuccess = options.onSuccess || (() => {});
    this.onRollback = options.onRollback || (() => {});
    this.getCurrentCampusId = options.getCurrentCampusId || (() => null);
    this.debounceMs = options.debounceMs ?? 400;

    this.queue = []; // Array<{ campusId, change, rollbackFn }>
    this.isInFlight = false;
    this.timer = null;
  }

  /**
   * 取得目前正在排程或傳輸中的變更筆數
   * @returns {number}
   */
  getPendingCount() {
    return this.queue.length + (this.isInFlight ? 1 : 0);
  }

  /**
   * 取得內部隊列副本（測試與偵錯專用）
   * @returns {Array}
   */
  getQueue() {
    return this.queue;
  }

  /**
   * 設定內部隊列（測試與偵錯專用）
   * @param {Array} q
   */
  setQueue(q) {
    this.queue = Array.isArray(q) ? q : [];
  }

  /**
   * 將後端回傳的最新人員快照與前端尚在隊列中的變更進行記憶體內合併
   * 防止在 RPC 請求在途 (in-flight) 期間，使用者連續修改其他成員時，
   * 因舊快照返回而導致「1秒短暫回滾」閃爍現象。
   * 
   * @param {Array} serverMembers 伺服器回傳之人員名單
   * @param {Array|string} [pendingQueueOrCampusId] 待處理隊列（若未傳入則使用內部 queue）或 campusId
   * @param {string} [optionalCampusId] 校園 ID（若第 2 參數為 pendingQueue 時使用）
   * @returns {Array} 合併後的人員名單副本
   */
  mergeServerMembersWithPendingQueue(serverMembers, pendingQueueOrCampusId, optionalCampusId) {
    if (!Array.isArray(serverMembers)) return [];

    let pendingQueue;
    let campusId;

    if (Array.isArray(pendingQueueOrCampusId)) {
      pendingQueue = pendingQueueOrCampusId;
      campusId = optionalCampusId || this.getCurrentCampusId();
    } else {
      pendingQueue = this.queue;
      campusId = pendingQueueOrCampusId || this.getCurrentCampusId();
    }

    const merged = serverMembers.map(m => ({
      ...m,
      defaults: Array.isArray(m.defaults) ? [...m.defaults] : []
    }));

    let hasAddedOrRenamed = false;
    for (const item of pendingQueue) {
      if (campusId && item.campusId && item.campusId !== campusId) continue;
      const change = item.change;
      if (!change) continue;

      if (change.type === 'modify') {
        const targetName = change.oldName || change.name;
        const target = merged.find(m => m.name === targetName || (change.oldName && m.name === change.oldName));
        if (target) {
          if (change.name && change.name !== target.name) {
            hasAddedOrRenamed = true;
          }
          target.name = change.name;
          target.role = change.role;
          target.stage = change.stage;
          target.defaults = Array.isArray(change.defaults) ? [...change.defaults] : [];
          if (change.otherGroupId !== undefined) target.otherGroupId = change.otherGroupId;
        }
      } else if (change.type === 'add') {
        if (!merged.some(m => m.name === change.name)) {
          merged.push({
            name: change.name,
            count: 0,
            role: change.role,
            stage: change.stage,
            defaults: Array.isArray(change.defaults) ? [...change.defaults] : [],
            otherGroupId: change.otherGroupId || ''
          });
          hasAddedOrRenamed = true;
        }
      } else if (change.type === 'delete') {
        const idx = merged.findIndex(m => m.name === change.name || (change.oldName && m.name === change.oldName));
        if (idx !== -1) merged.splice(idx, 1);
      }
    }
    if (hasAddedOrRenamed) {
      sortMemberList(merged);
    }
    return merged;
  }

  /**
   * 排程人員變更（支援多態呼叫：(campusId, change, rollbackFn, immediate) 或 (change, rollbackFn, immediate)）
   * 包含隊列聚合、改名鏈追蹤、自我消除等深模組行為。
   */
  scheduleMemberSync(campusIdOrChange, changeOrRollback, rollbackOrImmediate, immediate = false) {
    let targetCampusId, change, rollbackFn, isImmediate;

    if (typeof campusIdOrChange === 'string') {
      targetCampusId = campusIdOrChange;
      change = changeOrRollback;
      rollbackFn = rollbackOrImmediate;
      isImmediate = Boolean(immediate);
    } else {
      change = campusIdOrChange;
      rollbackFn = changeOrRollback;
      isImmediate = Boolean(rollbackOrImmediate);
      targetCampusId = (change && change.campusId) || this.getCurrentCampusId();
    }

    if (change) {
      if (change.type === 'modify') {
        const targetName = change.oldName || change.name;
        const existing = this.queue.find(item =>
          item.campusId === targetCampusId &&
          item.change && (
            (item.change.type === 'modify' && (item.change.name === targetName || (item.change.oldName && item.change.oldName === targetName))) ||
            (item.change.type === 'add' && item.change.name === targetName)
          )
        );
        if (existing) {
          if (existing.change.type === 'add') {
            existing.change.name = change.name;
            existing.change.role = change.role;
            existing.change.stage = change.stage;
            existing.change.defaults = Array.isArray(change.defaults) ? [...change.defaults] : [];
            if (change.otherGroupId !== undefined) existing.change.otherGroupId = change.otherGroupId;
          } else {
            const originalOldName = existing.change.oldName || existing.change.name;
            existing.change = change;
            if (originalOldName) {
              existing.change.oldName = originalOldName;
            }
          }
        } else {
          this.queue.push({ campusId: targetCampusId, change, rollbackFn });
        }
      } else if (change.type === 'delete') {
        const addIndex = this.queue.findIndex(item =>
          item.campusId === targetCampusId && item.change && item.change.type === 'add' && item.change.name === change.name
        );
        if (addIndex !== -1) {
          this.queue.splice(addIndex, 1);
        } else {
          this.queue.push({ campusId: targetCampusId, change, rollbackFn });
        }
      } else {
        this.queue.push({ campusId: targetCampusId, change, rollbackFn });
      }
    }

    this.onSyncStatusChange(this.getPendingCount());

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (isImmediate) {
      this.flushMemberSync();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushMemberSync();
    }, this.debounceMs);
  }

  /**
   * 立即將佇列批次送至伺服器，處理回滾與記憶體快照同步
   */
  async flushMemberSync() {
    if (this.isInFlight) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      this.onSyncStatusChange(this.getPendingCount());
      return;
    }

    const targetCampusId = this.queue[0].campusId || this.getCurrentCampusId();
    if (!targetCampusId) return;

    const batch = [];
    const remaining = [];
    for (const item of this.queue) {
      if (item.campusId === targetCampusId) batch.push(item);
      else remaining.push(item);
    }
    this.queue = remaining;

    const changes = batch.map(b => b.change);
    this.isInFlight = true;
    this.onSyncStatusChange(this.getPendingCount());

    try {
      if (typeof this.apiClient.applyMemberChanges !== 'function') {
        throw new Error('apiClient.applyMemberChanges 未定義');
      }

      const result = await this.apiClient.applyMemberChanges(targetCampusId, { changes });
      if (result && result.success) {
        let merged = null;
        if (Array.isArray(result.members)) {
          merged = this.mergeServerMembersWithPendingQueue(result.members, this.queue, targetCampusId);
        }

        this.onSuccess(targetCampusId, merged, result.affectedMembers, result.warnings);

        if (result.warnings && result.warnings.length > 0) {
          this.onToast(`已儲存名單（部分衝突已自動排除）：\n${result.warnings.join('\n')}`, 'warning');
        } else if (this.queue.length === 0) {
          this.onToast('人員變更已自動儲存', 'success');
        }
      } else {
        throw new Error(result && result.error ? result.error : '伺服器儲存失敗');
      }
    } catch (e) {
      for (let i = batch.length - 1; i >= 0; i--) {
        if (typeof batch[i].rollbackFn === 'function') {
          try { batch[i].rollbackFn(); } catch (err) {}
        }
      }
      this.onRollback(targetCampusId, batch, e);
      this.onToast(`人員儲存失敗 (${e.message})，已自動復原名單`, 'error');
    } finally {
      this.isInFlight = false;
      this.onSyncStatusChange(this.getPendingCount());
      if (this.queue.length > 0) {
        this.scheduleMemberSync(null, null, null, true);
      }
    }
  }

  /**
   * 與 flushMemberSync 等價之語法糖
   */
  flush() {
    return this.flushMemberSync();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MemberStore, sortMemberList };
}
