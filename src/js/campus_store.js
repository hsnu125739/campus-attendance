// ==========================================
// ===== CampusStore 前端深模組 =====
// ==========================================

/**
 * 小排管理 0ms 樂觀自動同步與回退管線深模組
 * 封裝排序序號正規化、分類分組、防抖計時器、快照比對 (防止無實質變更的無意義儲存) 與失敗回退。
 */
class CampusStore {
  /**
   * @param {Object} [options]
   * @param {Object} [options.apiClient] API Client 物件，需提供 applyCampusChanges(campuses)
   * @param {Function} [options.onSyncStatusChange] 同步狀態計數變更通知 (pendingCount) => void
   * @param {Function} [options.onToast] 提示通知 (msg, type) => void
   * @param {Function} [options.onSuccess] 儲存成功回調 () => void
   * @param {Function} [options.onRollback] 失敗回退回調 (rollbackSnapshot, error) => void
   * @param {Function} [options.getCurrentCampuses] 取得當前校園狀態回調 () => { campuses, archivedCampuses }
   * @param {number} [options.debounceMs=400] 防抖時間（毫秒）
   */
  constructor(options = {}) {
    this.apiClient = options.apiClient || {};
    this.onSyncStatusChange = options.onSyncStatusChange || (() => {});
    this.onToast = options.onToast || (() => {});
    this.onSuccess = options.onSuccess || (() => {});
    this.onRollback = options.onRollback || (() => {});
    this.getCurrentCampuses = options.getCurrentCampuses || (() => ({ campuses: [], archivedCampuses: [] }));
    this.debounceMs = options.debounceMs ?? 400;

    this.timer = null;
    this.isInFlight = false;
    this.rollbackSnapshot = null;
    this.hasPending = false;
  }

  /**
   * 建立當前校園狀態深拷貝快照
   * @param {Array} campuses 啟用校園清單
   * @param {Array} archivedCampuses 封存校園清單
   * @returns {{ campuses: Array, archivedCampuses: Array }}
   */
  captureSnapshot(campuses, archivedCampuses) {
    return {
      campuses: JSON.parse(JSON.stringify(campuses || [])),
      archivedCampuses: JSON.parse(JSON.stringify(archivedCampuses || []))
    };
  }

  /**
   * 比對兩個校園清單是否實質完全一致
   * @param {Array} listA
   * @param {Array} listB
   * @returns {boolean}
   */
  areCampusListsEqual(listA, listB) {
    if (!Array.isArray(listA) || !Array.isArray(listB)) return false;
    if (listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i++) {
      const a = listA[i];
      const b = listB[i];
      if (a.id !== b.id || a.name !== b.name || a.category !== b.category || (a.sort || 0) !== (b.sort || 0)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 取得目前正在排程或傳輸中的校園同步筆數
   * @returns {number}
   */
  getPendingCount() {
    return (this.hasPending ? 1 : 0) + (this.isInFlight ? 1 : 0);
  }

  /**
   * 檢查是否有未完成之校園排程或待同步快照
   * @returns {boolean}
   */
  hasPendingSync() {
    return this.hasPending || Boolean(this.rollbackSnapshot);
  }

  /**
   * 重新正規化校園排序號與分類順序
   * @param {Array} campuses
   */
  reorderAndSortCampuses(campuses) {
    if (!Array.isArray(campuses)) return;

    // 重新整理排序序號
    const groups = {};
    campuses.forEach(c => {
      const cat = c.category || '其他';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(c);
    });
    Object.values(groups).forEach(list => {
      list.sort((a, b) => (a.sort || 0) - (b.sort || 0)).forEach((c, idx) => {
        c.sort = idx + 1;
      });
    });

    // 依類別與序號排序 campuses 保持與試算表實體列一致
    const categoryOrder = { '高中': 1, '國中': 2, '社區排': 3 };
    campuses.sort((a, b) => {
      const catA = categoryOrder[a.category] || 99;
      const catB = categoryOrder[b.category] || 99;
      if (catA !== catB) return catA - catB;
      return (a.sort || 0) - (b.sort || 0);
    });
  }

  /**
   * 排程小排同步（支援立即送出或防抖延遲）
   * @param {Object} [prevSnapshot] 操作前回退快照
   * @param {boolean} [immediate=false] 是否立即 flush
   */
  scheduleCampusSync(prevSnapshot, immediate = false) {
    this.hasPending = true;
    if (!this.rollbackSnapshot && prevSnapshot) {
      this.rollbackSnapshot = prevSnapshot;
    }
    this.onSyncStatusChange(this.getPendingCount());

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (immediate) {
      this.flushCampusSync();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushCampusSync();
    }, this.debounceMs);
  }

  /**
   * 立即將校園變更批次同步至後端試算表
   * @param {Array} [currentCampuses] 當前啟用校園清單
   * @param {Array} [currentArchivedCampuses] 當前封存校園清單
   */
  async flushCampusSync(currentCampuses, currentArchivedCampuses) {
    if (this.isInFlight) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.hasPending) {
      this.onSyncStatusChange(this.getPendingCount());
      return;
    }

    this.hasPending = false;
    const rollback = this.rollbackSnapshot;
    this.rollbackSnapshot = null;
    this.isInFlight = true;
    this.onSyncStatusChange(this.getPendingCount());

    const activeCampuses = currentCampuses || this.getCurrentCampuses().campuses || [];
    const archivedCampuses = currentArchivedCampuses || this.getCurrentCampuses().archivedCampuses || [];

    this.reorderAndSortCampuses(activeCampuses);

    // 檢查是否與 rollback 快照完全一致（無實質變更時避免無意義儲存與網路請求）
    if (rollback &&
        this.areCampusListsEqual(rollback.campuses, activeCampuses) &&
        this.areCampusListsEqual(rollback.archivedCampuses, archivedCampuses)) {
      this.isInFlight = false;
      this.onSyncStatusChange(this.getPendingCount());
      return;
    }

    try {
      if (typeof this.apiClient.applyCampusChanges !== 'function') {
        throw new Error('apiClient.applyCampusChanges 未定義');
      }

      const allCampusesToSave = [
        ...activeCampuses.map(c => ({ ...c, isArchived: false })),
        ...archivedCampuses.map(c => ({ ...c, isArchived: true }))
      ];

      const result = await this.apiClient.applyCampusChanges(allCampusesToSave);
      if (result && result.success) {
        this.onSuccess();
        this.onToast('小排變更已自動儲存', 'success');
      } else {
        throw new Error(result && result.error ? result.error : '儲存失敗');
      }
    } catch (e) {
      this.onRollback(rollback, e);
      this.onToast(`小排儲存失敗 (${e.message})，已自動復原`, 'error');
    } finally {
      this.isInFlight = false;
      this.onSyncStatusChange(this.getPendingCount());
      if (this.hasPending) {
        this.scheduleCampusSync(null, true);
      }
    }
  }

  /**
   * 與 flushCampusSync 等價之語法糖
   */
  flush() {
    return this.flushCampusSync();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CampusStore };
}
