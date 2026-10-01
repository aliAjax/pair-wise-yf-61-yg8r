import { createAction, props } from '@ngrx/store';
import type { StorageFaultConfig, TelemetryReceipt } from './release.models';

export const createBatch = createAction(
  '[Release] Create batch',
  props<{ name: string; firmwareVersion: string; rollbackVersion: string; groupId: string; rolloutPercent: number; failureThreshold: number; actor?: string }>()
);
export const startBatch = createAction('[Release] Start batch', props<{ id: string; actor?: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor?: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor?: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor?: string }>());
export const changeVersion = createAction('[Release] Change batch version', props<{ id: string; firmwareVersion: string; actor?: string }>());
export const submitReceipts = createAction(
  '[Release] Submit receipts',
  props<{ batchId: string; receipts: TelemetryReceipt[]; baseRevision: number; actor?: string }>()
);
export const retryPendingReceipts = createAction('[Release] Retry pending receipts', props<{ id: string; actor?: string }>());
export const configureStorageFault = createAction('[Release] Configure storage fault', props<{ fault: StorageFaultConfig | null }>());
export const dismissReceiptResult = createAction('[Release] Dismiss receipt result');
export const telemetryTick = createAction('[Release] Telemetry tick');
