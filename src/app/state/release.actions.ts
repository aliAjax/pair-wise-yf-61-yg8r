import { createAction, props } from '@ngrx/store';
import type { BatchStatus, DeviceReceipt, ReceiptConflict, ReceiptStage, ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const telemetryTick = createAction('[Release] Telemetry tick');

/**
 * 提交一批回执。baseRevision 为提交者本地清单的账本版本，
 * 与服务端不一致时进入冲突，后到者看到冲突设备与最新批次。
 */
export const submitReceipts = createAction('[Release] Submit receipts', props<{
  batchId: string;
  receipts: Array<{ deviceId: string; stage: ReceiptStage; version: string }>;
  baseRevision: number;
  actor: string;
  clientId: string;
}>());
export const submitReceiptsSuccess = createAction('[Release] Submit receipts success', props<{
  batchId: string;
  applied: DeviceReceipt[];
  duplicates: string[];
  revision: number;
  clientId: string;
}>());
export const submitReceiptsConflict = createAction('[Release] Submit receipts conflict', props<{
  conflict: ReceiptConflict;
  clientId: string;
}>());
export const clearConflict = createAction('[Release] Clear conflict', props<{ clientId: string }>());

/** 批次版本变更：未执行（仅下载）回执立即失效，已安装设备保留结果 */
export const bumpBatchVersion = createAction('[Release] Bump batch version', props<{
  id: string;
  firmware: string;
  actor: string;
  reason: string;
}>());

/** 窗口释放后，等候批次自动补位（也可手动触发） */
export const promoteWaiting = createAction('[Release] Promote waiting', props<{ groupId: string }>());

/** 持久化失败/恢复（只重试未完成部分） */
export const storageFailure = createAction('[Release] Storage failure', props<{ pending: number }>());
export const storageRecovered = createAction('[Release] Storage recovered');
