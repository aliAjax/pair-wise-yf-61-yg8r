import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { BatchStatus, ReleaseState } from './release.models';
import { occupiesWindow } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectLedgerRevision = createSelector(selectRelease, (state) => state.ledgerRevision);
export const selectLastConflict = createSelector(selectRelease, (state) => state.lastConflict);
export const selectStorageStatus = createSelector(selectRelease, (state) => state.storageStatus);
export const selectReadOnly = createSelector(selectRelease, (state) => state.readOnly);

/** 分组当前的发布窗口占用者（运行或暂停中的批次） */
export const selectOccupant = (groupId: string) =>
  createSelector(selectBatches, (batches) => batches.find((b) => b.groupId === groupId && occupiesWindow(b.status)) ?? null);

/** 分组的等候批次（按创建时间排序） */
export const selectWaitingForGroup = (groupId: string) =>
  createSelector(selectBatches, (batches) =>
    batches
      .filter((b) => b.groupId === groupId && b.status === 'waiting')
      .sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt))
  );

export interface DeviceLedgerRow {
  deviceId: string;
  level: number;
  stage: 'pending' | 'downloaded' | 'installed' | 'rebooted';
}

export interface BatchLedger {
  batchId: string;
  target: number;
  downloaded: number;
  installed: number;
  rebooted: number;
  devices: DeviceLedgerRow[];
}

const STAGE_LABELS = ['pending', 'downloaded', 'installed', 'rebooted'] as const;

/** 按设备号展示批次的下载/安装/重启账本 */
export const selectBatchLedger = (batchId: string) =>
  createSelector(selectRelease, (state): BatchLedger => {
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch) return { batchId, target: 0, downloaded: 0, installed: 0, rebooted: 0, devices: [] };
    const group = state.groups.find((g) => g.id === batch.groupId);
    const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
    const levels = new Map<string, number>();
    for (const r of state.receipts) {
      if (r.batchId !== batchId) continue;
      // 下载回执按当前版本判定有效性；安装/重启跨版本保留
      if (r.stage === 'downloaded' && r.version !== batch.firmware) continue;
      const w = r.stage === 'downloaded' ? 1 : r.stage === 'installed' ? 2 : 3;
      levels.set(r.deviceId, Math.max(levels.get(r.deviceId) ?? 0, w));
    }
    const devices: DeviceLedgerRow[] = [];
    let downloaded = 0;
    let installed = 0;
    let rebooted = 0;
    for (let d = 1; d <= target; d++) {
      const deviceId = String(d);
      const level = levels.get(deviceId) ?? 0;
      if (level >= 1) downloaded++;
      if (level >= 2) installed++;
      if (level >= 3) rebooted++;
      devices.push({ deviceId, level, stage: STAGE_LABELS[level] });
    }
    return { batchId, target, downloaded, installed, rebooted, devices };
  });

/** 批次的等候位次（0=不在等候） */
export const selectWaitingRank = (batchId: string) =>
  createSelector(selectBatches, (batches) => {
    const batch = batches.find((b) => b.id === batchId);
    if (!batch || batch.status !== 'waiting') return 0;
    const sameGroup = batches
      .filter((b) => b.groupId === batch.groupId && b.status === 'waiting')
      .sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt));
    return sameGroup.findIndex((b) => b.id === batchId) + 1;
  });

export const statusLabel = (status: BatchStatus): string => {
  switch (status) {
    case 'draft': return '草稿';
    case 'approved': return '已审批';
    case 'running': return '发布中';
    case 'paused': return '已暂停';
    case 'completed': return '已完成';
    case 'rolled_back': return '已回滚';
    case 'waiting': return '等候中';
  }
};
