import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { DeviceGroup, ReleaseBatch, ReleaseState } from './release.models';
import { ledgerCounters, OCCUPYING_STATUSES, waitingBatches } from './release.ledger';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectStorageFault = createSelector(selectRelease, (state) => state.storageFault);
export const selectLastReceiptResult = createSelector(selectRelease, (state) => state.lastReceiptResult);

export interface GroupWindow {
  group: DeviceGroup;
  occupant: ReleaseBatch | null;
  waiting: ReleaseBatch[];
}

/** 每个设备分组的发布窗口：谁占用、谁在等候，值班员一眼可见。 */
export const selectGroupWindows = createSelector(selectRelease, (state): GroupWindow[] =>
  state.groups.map((group) => ({
    group,
    occupant: state.batches.find((batch) => batch.groupId === group.id && OCCUPYING_STATUSES.includes(batch.status)) ?? null,
    waiting: waitingBatches(state, group.id)
  }))
);

export const selectBatchById = (id: string) => createSelector(selectBatches, (batches) => batches.find((batch) => batch.id === id) ?? null);

export interface BatchView extends ReleaseBatch {
  counters: ReturnType<typeof ledgerCounters>;
  readonly: boolean;
}

export const selectBatchViews = createSelector(selectBatches, (batches): BatchView[] =>
  batches.map((batch) => ({ ...batch, counters: ledgerCounters(batch), readonly: batch.status === 'legacy_readonly' }))
);

export const selectRunningCount = createSelector(selectBatches, (batches) => batches.filter((batch) => batch.status === 'running').length);
export const selectWaitingCount = createSelector(selectBatches, (batches) => batches.filter((batch) => batch.status === 'waiting').length);
export const selectLegacyCount = createSelector(selectBatches, (batches) => batches.filter((batch) => batch.status === 'legacy_readonly').length);
