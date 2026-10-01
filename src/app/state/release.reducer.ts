import { createReducer, on } from '@ngrx/store';
import type { ReleaseState, TelemetryReceipt } from './release.models';
import {
  changeBatchVersion,
  createBatch as createBatchLedger,
  faultAwareStore,
  ledgerCounters,
  pauseBatch as pauseBatchLedger,
  resumeBatch as resumeBatchLedger,
  retryPendingReceipts,
  rollbackBatch as rollbackBatchLedger,
  startBatch as startBatchLedger,
  submitReceipts as submitReceiptsLedger,
  withAudit
} from './release.ledger';
import {
  changeVersion,
  configureStorageFault,
  createBatch,
  dismissReceiptResult,
  pauseBatch,
  resumeBatch,
  retryPendingReceipts as retryPendingReceiptsAction,
  rollbackBatch,
  startBatch,
  submitReceipts,
  telemetryTick
} from './release.actions';
import { loadInitialState, STORAGE_KEY_V2 } from './release.storage';

const initialState = loadInitialState();

/**
 * 遥测模拟：为每个运行中批次挑选下一台未重启的目标设备，推进一个阶段，
 * 偶发重发同一条回执（验证去重）。所有模拟数据都走提交链路，不直接改账。
 */
function simulateTick(state: ReleaseState): ReleaseState {
  let next = state;
  const store = faultAwareStore(state.storageFault);
  // 遥测模拟不覆盖值班员人工提交的结果卡片。
  const humanResult = state.lastReceiptResult;
  for (const batch of state.batches.filter((item) => item.status === 'running')) {
    const counters = ledgerCounters(batch);
    if (counters.rebooted >= counters.target) continue;
    // 约 8% 概率注入一台设备失败，供失败阈值自动暂停使用。
    if (Math.random() < 0.08 && batch.failed < counters.target) {
      const at = new Date().toISOString();
      next = {
        ...next,
        batches: next.batches.map((item) => item.id === batch.id ? { ...item, failed: item.failed + 1, updatedAt: at, revision: item.revision + 1 } : item),
        audits: withAudit(next, { now: () => at, uuid: () => `tel-fail-${Math.random().toString(36).slice(2)}` }, '遥测模拟器', `批次 ${batch.name} 一台设备上报失败，累计 ${batch.failed + 1} 台`)
      };
    }
    const device = batch.deviceIds.find((id) => {
      const entry = batch.ledger.find((item) => item.deviceId === id);
      return !entry || entry.stage !== 'rebooted';
    });
    if (!device) continue;
    const entry = batch.ledger.find((item) => item.deviceId === device);
    const nextStage = !entry ? 'downloaded' : entry.stage === 'downloaded' ? 'installed' : 'rebooted';
    const already = entry?.stages.find((event) => event.stage === nextStage);
    const id = already?.receiptId ?? `tel-${batch.id}-${device}-${nextStage}`;
    const receipt: TelemetryReceipt = {
      id,
      batchId: batch.id,
      deviceId: device,
      stage: nextStage,
      firmwareVersion: batch.firmwareVersion,
      at: new Date().toISOString()
    };
    const simClock = () => ({ now: () => new Date().toISOString(), uuid: () => `tel-audit-${Math.random().toString(36).slice(2)}` });
    const latest = next.batches.find((item) => item.id === batch.id) ?? batch;
    next = submitReceiptsLedger(next, { batchId: batch.id, receipts: [receipt], baseRevision: latest.revision, actor: '遥测模拟器', store, silent: true }, simClock());
    // 约 15% 概率重发刚送达的同号回执，验证重复回执只出现一次。
    if (Math.random() < 0.15) {
      const replayed = next.batches.find((item) => item.id === batch.id) ?? latest;
      next = submitReceiptsLedger(next, { batchId: batch.id, receipts: [receipt], baseRevision: replayed.revision, actor: '遥测模拟器(重发)', store, silent: true }, simClock());
    }
  }
  if (humanResult !== next.lastReceiptResult) next = { ...next, lastReceiptResult: humanResult };
  return next;
}

/** 失败率自动暂停：按当前版本设备账重算，不依赖历史计数。 */
function applyFailureGuard(state: ReleaseState, before: ReleaseState): ReleaseState {
  for (const batch of state.batches) {
    if (batch.status !== 'running') continue;
    const previous = before.batches.find((item) => item.id === batch.id);
    if (previous?.status !== 'running') continue;
    const counters = ledgerCounters(batch);
    if (counters.downloaded === 0) continue;
    const rate = batch.failed / counters.downloaded * 100;
    if (rate > batch.failureThreshold) {
      const at = new Date().toISOString();
      state = {
        ...state,
        batches: state.batches.map((item) => item.id === batch.id ? { ...item, status: 'paused', updatedAt: at, revision: item.revision + 1 } : item),
        audits: withAudit(state, { now: () => at, uuid: () => `guard-${Math.random().toString(36).slice(2)}` }, '系统', `批次 ${batch.name} 失败率 ${rate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%，已自动暂停`)
      };
    }
  }
  return state;
}

function persist(state: ReleaseState): void {
  try {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(state));
  } catch {
    // 单次写入失败不影响内存账，下个 tick 会重试整体持久化。
  }
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, props) => createBatchLedger(state, props)),
  on(startBatch, (state, { id, actor }) => startBatchLedger(state, id, actor)),
  on(pauseBatch, (state, { id, actor }) => pauseBatchLedger(state, id, actor)),
  on(resumeBatch, (state, { id, actor }) => resumeBatchLedger(state, id, actor)),
  on(rollbackBatch, (state, { id, actor }) => rollbackBatchLedger(state, id, actor)),
  on(changeVersion, (state, { id, firmwareVersion, actor }) => changeBatchVersion(state, id, firmwareVersion, actor)),
  on(submitReceipts, (state, props) => submitReceiptsLedger(state, { ...props, store: faultAwareStore(state.storageFault) })),
  on(retryPendingReceiptsAction, (state, { id, actor }) => retryPendingReceipts(state, id, actor ?? '值班员', faultAwareStore(state.storageFault))),
  on(configureStorageFault, (state, { fault }) => ({ ...state, storageFault: fault })),
  on(dismissReceiptResult, (state) => ({ ...state, lastReceiptResult: null })),
  on(telemetryTick, (state) => {
    const before = state;
    const ticked = simulateTick(state);
    const guarded = applyFailureGuard(ticked, before);
    persist(guarded);
    return guarded;
  })
);
