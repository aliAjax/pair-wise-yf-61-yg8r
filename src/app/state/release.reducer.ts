import { createReducer, on } from '@ngrx/store';
import type {
  AuditEntry,
  BatchStatus,
  DeviceReceipt,
  ReceiptConflict,
  ReleaseBatch,
  ReleaseState
} from './release.models';
import { STAGE_WEIGHT, occupiesWindow } from './release.models';
import {
  approveBatch,
  bumpBatchVersion,
  clearConflict,
  createBatch,
  pauseBatch,
  promoteWaiting,
  resumeBatch,
  rollbackBatch,
  storageFailure,
  storageRecovered,
  submitReceipts,
  telemetryTick
} from './release.actions';
import { loadStateFromStorage } from './ledger.persistence';

const initialGroups = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];

function fallbackState(): ReleaseState {
  const now = new Date().toISOString();
  const demo: ReleaseBatch = {
    id: 'batch-demo',
    name: '边缘网关安全补丁 2.8.1',
    firmware: '2.8.1',
    rollbackVersion: '2.7.9',
    groupId: 'g-edge',
    rolloutPercent: 20,
    failureThreshold: 5,
    status: 'approved',
    progress: 0,
    downloaded: 0,
    installed: 0,
    rebooted: 0,
    failed: 0,
    createdAt: now,
    updatedAt: now,
    versionHistory: []
  };
  return {
    schemaVersion: 2,
    readOnly: false,
    groups: initialGroups,
    batches: [demo],
    audits: [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }],
    receipts: [],
    ledgerRevision: 0,
    lastConflict: null,
    pendingWrites: [],
    storageStatus: 'ok'
  };
}

const stored = loadStateFromStorage();
const initialState: ReleaseState = stored ?? fallbackState();

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 幂等键：批次 + 设备号 + 阶段 + 版本，重复回执只出现一次 */
function receiptKey(r: Pick<DeviceReceipt, 'batchId' | 'deviceId' | 'stage' | 'version'>): string {
  return `${r.batchId}|${r.deviceId}|${r.stage}|${r.version}`;
}

/**
 * 回执是否计入当前批次：
 * - 下载回执必须与当前固件版本一致（版本一变即失效）；
 * - 安装/重启回执跨版本保留（已安装设备仍留结果）。
 */
function isValidReceipt(batch: ReleaseBatch, r: DeviceReceipt): boolean {
  if (r.batchId !== batch.id) return false;
  if (r.stage === 'downloaded') return r.version === batch.firmware;
  return true;
}

/** 计算批次内每台设备的最高阶段（0=未执行，1=已下载，2=已安装，3=已重启） */
function deviceLevels(batch: ReleaseBatch, receipts: DeviceReceipt[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const r of receipts) {
    if (!isValidReceipt(batch, r)) continue;
    const w = STAGE_WEIGHT[r.stage];
    levels.set(r.deviceId, Math.max(levels.get(r.deviceId) ?? 0, w));
  }
  return levels;
}

function rolloutTarget(batch: ReleaseBatch, state: ReleaseState): number {
  const group = state.groups.find((g) => g.id === batch.groupId);
  return Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
}

/**
 * 按账本重算批次进度。
 * 仅 running 状态推进；paused 冻结（晚到回执不重新计入）；
 * 终态批次永不回退进度。
 */
function recomputeBatch(batch: ReleaseBatch, receipts: DeviceReceipt[], state: ReleaseState): ReleaseBatch {
  if (batch.status !== 'running') return batch;
  const target = rolloutTarget(batch, state);
  const levels = deviceLevels(batch, receipts);
  let downloaded = 0;
  let installed = 0;
  let rebooted = 0;
  for (const lvl of levels.values()) {
    if (lvl >= 1) downloaded++;
    if (lvl >= 2) installed++;
    if (lvl >= 3) rebooted++;
  }
  downloaded = Math.min(downloaded, target);
  installed = Math.min(installed, target);
  rebooted = Math.min(rebooted, target);
  const progress = target ? Math.round(downloaded / target * 100) : 0;
  const status: BatchStatus = target > 0 && downloaded >= target ? 'completed' : batch.status;
  return { ...batch, downloaded, installed, rebooted, progress, status, updatedAt: nowIso() };
}

/** 窗口释放后，同分组最早的等候批次补位为已审批 */
function promoteWaitingBatches(batches: ReleaseBatch[]): ReleaseBatch[] {
  const occupied = new Set(batches.filter((b) => occupiesWindow(b.status)).map((b) => b.groupId));
  const earliest = new Map<string, ReleaseBatch>();
  for (const b of batches) {
    if (b.status !== 'waiting') continue;
    if (occupied.has(b.groupId)) continue;
    const cur = earliest.get(b.groupId);
    if (!cur || (b.createdAt ?? b.updatedAt).localeCompare(cur.createdAt ?? cur.updatedAt) < 0) {
      earliest.set(b.groupId, b);
    }
  }
  if (earliest.size === 0) return batches;
  const promoteIds = new Set([...earliest.values()].map((b) => b.id));
  return batches.map((b) => (promoteIds.has(b.id) ? { ...b, status: 'approved' as BatchStatus, updatedAt: nowIso() } : b));
}

export const releaseReducer = createReducer(
  initialState,

  on(createBatch, (state, { batch }) => {
    if (state.readOnly) return state;
    const occupant = state.batches.some((b) => b.groupId === batch.groupId && occupiesWindow(b.status));
    const status: BatchStatus = occupant ? 'waiting' : 'draft';
    const withDefaults: ReleaseBatch = {
      ...batch,
      status,
      createdAt: batch.createdAt ?? nowIso(),
      installed: batch.installed ?? 0,
      rebooted: batch.rebooted ?? 0,
      versionHistory: batch.versionHistory ?? []
    };
    return {
      ...state,
      batches: [withDefaults, ...state.batches],
      audits: audit(state, '发布负责人', occupant ? `批次 ${batch.name} 进入等候（发布窗口被占用）` : `创建批次 ${batch.name}`)
    };
  }),

  on(approveBatch, (state, { id, actor }) => {
    if (state.readOnly) return state;
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'approved', updatedAt: nowIso() } : batch)),
      audits: audit(state, actor, `批次 ${id} 审批通过`)
    };
  }),

  on(pauseBatch, (state, { id, actor }) => {
    if (state.readOnly) return state;
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'paused', updatedAt: nowIso() } : batch)),
      audits: audit(state, actor, `批次 ${id} 已暂停`)
    };
  }),

  on(resumeBatch, (state, { id, actor }) => {
    if (state.readOnly) return state;
    const batch = state.batches.find((b) => b.id === id);
    if (!batch || batch.status !== 'paused') return state;
    const recomputed = recomputeBatch({ ...batch, status: 'running' }, state.receipts, state);
    return {
      ...state,
      batches: state.batches.map((b) => (b.id === id ? recomputed : b)),
      audits: audit(state, actor, `批次 ${id} 恢复发布，按当前账本重算进度`)
    };
  }),

  on(rollbackBatch, (state, { id, actor }) => {
    if (state.readOnly) return state;
    const batch = state.batches.find((b) => b.id === id);
    if (!batch || batch.status === 'rolled_back' || batch.status === 'completed') return state;
    const updated: ReleaseBatch = { ...batch, status: 'rolled_back', updatedAt: nowIso() };
    let batches = state.batches.map((b) => (b.id === id ? updated : b));
    batches = promoteWaitingBatches(batches);
    return {
      ...state,
      batches,
      audits: audit(state, actor, `批次 ${id} 已紧急回滚，发布窗口释放，等候批次补位`)
    };
  }),

  on(promoteWaiting, (state, { groupId }) => {
    if (state.readOnly) return state;
    const batches = promoteWaitingBatches(state.batches);
    const promoted = batches.filter((b, i) => b.status === 'approved' && state.batches[i]?.status === 'waiting' && b.groupId === groupId);
    return {
      ...state,
      batches,
      audits: promoted.length ? audit(state, '系统', `分组 ${groupId} 窗口空闲，${promoted.length} 个等候批次补位`) : state.audits
    };
  }),

  on(bumpBatchVersion, (state, { id, firmware, actor, reason }) => {
    if (state.readOnly) return state;
    const batch = state.batches.find((b) => b.id === id);
    if (!batch || batch.status === 'rolled_back' || batch.firmware === firmware) return state;
    const oldVersion = batch.firmware;
    const updated: ReleaseBatch = {
      ...batch,
      firmware,
      versionHistory: [...(batch.versionHistory ?? []), { version: firmware, at: nowIso(), actor, reason }]
    };
    const recomputed = recomputeBatch(updated, state.receipts, state);
    const batches = state.batches.map((b) => (b.id === id ? recomputed : b));
    const invalidated = state.receipts.filter(
      (r) => r.batchId === id && r.version === oldVersion && r.stage === 'downloaded'
    ).length;
    return {
      ...state,
      batches,
      ledgerRevision: state.ledgerRevision + 1,
      lastConflict: null,
      audits: audit(state, actor, `批次 ${batch.name} 版本 ${oldVersion} → ${firmware}：${invalidated} 条已下载回执失效，已安装设备保留结果`)
    };
  }),

  on(submitReceipts, (state, { batchId, receipts, baseRevision, actor, clientId }) => {
    if (state.readOnly) return state;
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch) return state;

    // 乐观并发：后到者看到冲突设备与最新批次
    if (baseRevision !== state.ledgerRevision) {
      const incomingDeviceIds = [...new Set(receipts.map((r) => r.deviceId))];
      const existing = new Set(state.receipts.filter((r) => r.batchId === batchId).map((r) => r.deviceId));
      const conflictingDevices = incomingDeviceIds.filter((d) => existing.has(d));
      const latestBatch = recomputeBatch(batch, state.receipts, state);
      const conflict: ReceiptConflict = {
        batchId,
        clientId,
        at: nowIso(),
        actor,
        baseRevision,
        serverRevision: state.ledgerRevision,
        conflictingDevices,
        latestBatch,
        message: `账本已更新至 #${state.ledgerRevision}，你的清单版本 #${baseRevision} 已过期`
      };
      return {
        ...state,
        lastConflict: conflict,
        audits: audit(state, actor, `回执冲突：${conflictingDevices.length} 台设备已有回执，请按最新批次重试未完成部分`)
      };
    }

    // 幂等写入：重复回执只出现一次
    const existingKeys = new Set(state.receipts.map(receiptKey));
    const applied: DeviceReceipt[] = [];
    const duplicates: string[] = [];
    for (const input of receipts) {
      if (input.version !== batch.firmware) {
        duplicates.push(input.deviceId);
        continue;
      }
      const receipt: DeviceReceipt = {
        id: crypto.randomUUID(),
        batchId,
        deviceId: input.deviceId,
        stage: input.stage,
        version: input.version,
        at: nowIso(),
        actor
      };
      const key = receiptKey(receipt);
      if (existingKeys.has(key)) {
        duplicates.push(input.deviceId);
        continue;
      }
      existingKeys.add(key);
      applied.push(receipt);
    }

    if (applied.length === 0) {
      return { ...state, lastConflict: null };
    }

    const receipts2 = [...state.receipts, ...applied];
    let batches = state.batches.map((b) => (b.id === batchId ? recomputeBatch(b, receipts2, state) : b));
    batches = promoteWaitingBatches(batches);
    const completed = batches.find((b) => b.id === batchId)?.status === 'completed' && batch.status !== 'completed';
    return {
      ...state,
      receipts: receipts2,
      batches,
      ledgerRevision: state.ledgerRevision + 1,
      lastConflict: null,
      audits: audit(
        state,
        actor,
        `提交 ${applied.length} 条回执（重复 ${duplicates.length} 条已忽略）${completed ? '，批次已完成，发布窗口释放' : ''}`
      )
    };
  }),

  on(clearConflict, (state, { clientId }) => ({
    ...state,
    lastConflict: state.lastConflict?.clientId === clientId ? null : state.lastConflict
  })),

  on(storageFailure, (state) => ({ ...state, storageStatus: 'degraded' })),
  on(storageRecovered, (state) => ({ ...state, storageStatus: 'ok' })),

  on(telemetryTick, (state) => {
    if (state.readOnly) return state;
    const now = nowIso();
    const newReceipts: DeviceReceipt[] = [];
    let batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const target = rolloutTarget(batch, state);
      const levels = deviceLevels(batch, state.receipts);
      // 遥测补录尚未下载的设备
      const candidates: number[] = [];
      for (let d = 1; d <= target; d++) {
        if ((levels.get(String(d)) ?? 0) < 1) candidates.push(d);
      }
      const count = Math.min(candidates.length, 1 + Math.floor(Math.random() * 2));
      for (let i = 0; i < count; i++) {
        newReceipts.push({
          id: crypto.randomUUID(),
          batchId: batch.id,
          deviceId: String(candidates[i]),
          stage: 'downloaded',
          version: batch.firmware,
          at: now,
          actor: '遥测自动'
        });
      }
      // 偶发安装/重启回执
      if (Math.random() < 0.35) {
        const downloaded = [...levels.entries()].filter(([, lvl]) => lvl >= 1 && lvl < 3);
        if (downloaded.length) {
          const [deviceId, lvl] = downloaded[Math.floor(Math.random() * downloaded.length)];
          newReceipts.push({
            id: crypto.randomUUID(),
            batchId: batch.id,
            deviceId,
            stage: lvl >= 2 ? 'rebooted' : 'installed',
            version: batch.firmware,
            at: now,
            actor: '遥测自动'
          });
        }
      }
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      return { ...batch, failed };
    });

    // 账本内去重（含与已有回执重复的部分）
    const existingKeys = new Set(state.receipts.map(receiptKey));
    const unique = newReceipts.filter((r) => {
      const key = receiptKey(r);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    const receipts = [...state.receipts, ...unique];

    batches = batches.map((b) => (b.status === 'running' ? recomputeBatch(b, receipts, state) : b));

    // 失败率超阈值自动暂停（暂停后晚到回执不再计入）
    let autoPaused = false;
    batches = batches.map((b) => {
      if (b.status !== 'running') return b;
      const rate = b.downloaded ? (b.failed / b.downloaded) * 100 : 0;
      if (rate > b.failureThreshold) {
        autoPaused = true;
        return { ...b, status: 'paused' as BatchStatus, updatedAt: nowIso() };
      }
      return b;
    });

    return {
      ...state,
      batches,
      receipts,
      ledgerRevision: unique.length ? state.ledgerRevision + 1 : state.ledgerRevision,
      audits: autoPaused ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits
    };
  })
);
