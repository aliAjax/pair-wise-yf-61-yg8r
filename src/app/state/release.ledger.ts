import type {
  AuditEntry,
  BatchStatus,
  DeviceGroup,
  DeviceLedgerEntry,
  DeviceStage,
  DeviceStageEvent,
  HeldReceipt,
  ReceiptConflict,
  ReceiptStore,
  ReceiptSubmitResult,
  ReleaseBatch,
  ReleaseState,
  RetainedDeviceResult,
  TelemetryReceipt
} from './release.models';

export const STAGE_RANK: Record<DeviceStage, number> = { downloaded: 1, installed: 2, rebooted: 3 };
export const OCCUPYING_STATUSES: BatchStatus[] = ['running', 'paused'];
export const ACTIVE_STATUSES: BatchStatus[] = ['draft', 'approved', 'waiting', 'running', 'paused'];

export interface Clock {
  now(): string;
  uuid(): string;
}

export const defaultClock: Clock = {
  now: () => new Date().toISOString(),
  uuid: () => crypto.randomUUID()
};

export function deviceId(groupId: string, index: number): string {
  return `${groupId}-dev-${String(index + 1).padStart(4, '0')}`;
}

/** 灰度目标设备：按比例从前到后取，版本重算时排除已经留下历史结果的设备。 */
export function targetDeviceIds(group: DeviceGroup | undefined, rolloutPercent: number, retained: RetainedDeviceResult[] = []): string[] {
  const total = group?.count ?? 0;
  const target = Math.round(total * rolloutPercent / 100);
  const retainedIds = new Set(retained.map((item) => item.deviceId));
  const ids: string[] = [];
  for (let i = 0; ids.length < target && i < total; i++) {
    const id = deviceId(group?.id ?? 'g', i);
    if (!retainedIds.has(id)) ids.push(id);
  }
  return ids;
}

export function withAudit(state: ReleaseState, clock: Clock, actor: string, message: string): AuditEntry[] {
  const entry: AuditEntry = { id: clock.uuid(), at: clock.now(), actor, message };
  return [entry, ...state.audits];
}

function touch(batch: ReleaseBatch, at: string, revision?: number): ReleaseBatch {
  return { ...batch, updatedAt: at, revision: revision ?? batch.revision + 1 };
}

/** 所有目标设备都重启完成：状态由当前版本设备账决定。 */
function isFullyRebooted(batch: ReleaseBatch): boolean {
  return batch.deviceIds.length > 0 && batch.ledger.length === batch.deviceIds.length &&
    batch.ledger.every((entry) => entry.stage === 'rebooted');
}

/** 发布窗口：一个分组同一时刻只允许一个运行/暂停中的批次占用。 */
export function occupantOf(state: ReleaseState, groupId: string): ReleaseBatch | undefined {
  return state.batches.find((batch) => batch.groupId === groupId && OCCUPYING_STATUSES.includes(batch.status));
}

export function waitingBatches(state: ReleaseState, groupId: string): ReleaseBatch[] {
  return state.batches
    .filter((batch) => batch.groupId === groupId && batch.status === 'waiting')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** 占用批次离开窗口（完成/回滚）后，队列里最早等候的批次自动接管窗口。 */
function promoteWaiters(state: ReleaseState, clock: Clock): ReleaseState {
  let batches = state.batches;
  let audits = state.audits;
  const groupIds = new Set(state.groups.map((group) => group.id));
  for (const groupId of groupIds) {
    if (occupantOf({ ...state, batches }, groupId)) continue;
    const next = batches
      .filter((batch) => batch.groupId === groupId && batch.status === 'waiting')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!next) continue;
    const replay = applyHeldReceipts({ ...next, status: 'running', updatedAt: clock.now(), revision: next.revision + 1 }, clock);
    batches = batches.map((batch) => batch.id === next.id ? replay.batch : batch);
    audits = [{ id: clock.uuid(), at: clock.now(), actor: '系统', message: `分组 ${groupId} 发布窗口空闲，等候批次 ${next.name} 自动接管，重放 ${replay.replayed} 条暂存回执` }, ...audits];
  }
  return { ...state, batches, audits };
}

function isOccupying(status: BatchStatus): boolean {
  return OCCUPYING_STATUSES.includes(status);
}

export interface CreateBatchInput {
  name: string;
  firmwareVersion: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  actor?: string;
}

export function createBatch(state: ReleaseState, input: CreateBatchInput, clock: Clock = defaultClock): ReleaseState {
  const at = clock.now();
  const group = state.groups.find((item) => item.id === input.groupId);
  const occupied = !!occupantOf(state, input.groupId);
  const batch: ReleaseBatch = {
    id: clock.uuid(),
    name: input.name,
    firmwareVersion: input.firmwareVersion,
    rollbackVersion: input.rollbackVersion,
    groupId: input.groupId,
    rolloutPercent: input.rolloutPercent,
    failureThreshold: input.failureThreshold,
    // 分组被运行批次占用时，新批次直接进入等候。
    status: occupied ? 'waiting' : 'approved',
    revision: 1,
    deviceIds: targetDeviceIds(group, input.rolloutPercent),
    ledger: [],
    heldReceipts: [],
    retainedResults: [],
    seenReceiptIds: [],
    failed: 0,
    createdAt: at,
    updatedAt: at
  };
  const message = occupied
    ? `创建批次 ${batch.name}（${input.firmwareVersion}），分组窗口被占用，进入等候队列`
    : `创建批次 ${batch.name}（${input.firmwareVersion}）并通过兼容性检查，进入已审批`;
  return {
    ...state,
    batches: [batch, ...state.batches],
    audits: withAudit(state, clock, input.actor ?? '发布负责人', message)
  };
}

/** 开始发布：窗口被占则进入等候；接管窗口时先重放暂存回执。 */
export function startBatch(state: ReleaseState, id: string, actor = '值班人员', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch || !['approved', 'waiting'].includes(batch.status)) return state;
  const occupied = occupantOf(state, batch.groupId);
  if (occupied && occupied.id !== id) {
    const updated = touch({ ...batch, status: 'waiting' }, clock.now());
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? updated : item),
      audits: withAudit(state, clock, actor, `批次 ${batch.name} 请求发布，窗口由 ${occupied.name} 占用，进入等候`)
    };
  }
  const replay = applyHeldReceipts({ ...batch, status: 'running' }, clock);
  return {
    ...state,
    batches: state.batches.map((item) => item.id === id ? touch(replay.batch, clock.now(), replay.batch.revision) : item),
    audits: withAudit(state, clock, actor, `批次 ${batch.name} 开始发布，占用分组 ${batch.groupId} 发布窗口，重放 ${replay.replayed} 条暂存回执`)
  };
}

export function pauseBatch(state: ReleaseState, id: string, actor = '值班人员', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch || batch.status !== 'running') return state;
  return transition(state, batch, 'paused', actor, `批次 ${batch.name} 已暂停，窗口保持占用，离线回执暂存不计账`, clock);
}

export function resumeBatch(state: ReleaseState, id: string, actor = '运维人员', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch || batch.status !== 'paused') return state;
  const replay = applyHeldReceipts({ ...batch, status: 'running' }, clock);
  return {
    ...state,
    batches: state.batches.map((item) => item.id === id ? touch(replay.batch, clock.now(), replay.batch.revision) : item),
    audits: withAudit(state, clock, actor, `批次 ${batch.name} 恢复发布，按当前版本重放 ${replay.replayed} 条暂存回执，作废 ${replay.dropped} 条`)
  };
}

export function rollbackBatch(state: ReleaseState, id: string, actor = '发布负责人', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch || !['approved', 'running', 'waiting', 'paused'].includes(batch.status)) return state;
  const transitioned = transition(state, batch, 'rolled_back', actor, `批次 ${batch.name} 已紧急回滚至 ${batch.rollbackVersion}，离线回执只暂存不再计账`, clock);
  return promoteWaiters(transitioned, clock);
}

export function completeBatch(state: ReleaseState, id: string, actor = '系统', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch) return state;
  const transitioned = transition(state, batch, 'completed', actor, `批次 ${batch.name} 全部设备重启完成，发布结束`, clock);
  return promoteWaiters(transitioned, clock);
}

function transition(state: ReleaseState, batch: ReleaseBatch, status: BatchStatus, actor: string, message: string, clock: Clock): ReleaseState {
  const wasOccupying = isOccupying(batch.status);
  const updated = touch({ ...batch, status }, clock.now());
  let next: ReleaseState = {
    ...state,
    batches: state.batches.map((item) => item.id === batch.id ? updated : item),
    audits: withAudit(state, clock, actor, message)
  };
  if (wasOccupying && !isOccupying(status)) next = promoteWaiters(next, clock);
  return next;
}

/**
 * 批次版本变更：
 * - 未执行（仅下载）的账上记录与暂存回执立即失效，按新版本重算目标设备；
 * - 已安装/已重启的设备保留历史结果，且不再进入新版本目标；
 * - 去重索引保留，旧回执重复送达仍是重复。
 */
export function changeBatchVersion(state: ReleaseState, id: string, firmwareVersion: string, actor = '发布负责人', clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  if (!batch || !ACTIVE_STATUSES.includes(batch.status) || firmwareVersion === batch.firmwareVersion) return state;
  const at = clock.now();
  const group = state.groups.find((item) => item.id === batch.groupId);
  const retained: RetainedDeviceResult[] = [
    ...batch.retainedResults,
    ...batch.ledger
      .filter((entry) => STAGE_RANK[entry.stage] >= STAGE_RANK.installed)
      .map((entry) => ({
        deviceId: entry.deviceId,
        firmwareVersion: entry.firmwareVersion,
        stage: entry.stage,
        stages: entry.stages,
        retainedAt: at
      }))
  ];
  const droppedLedger = batch.ledger.filter((entry) => entry.stage === 'downloaded').length;
  const droppedHeld = batch.heldReceipts.length;
  const recalculated: ReleaseBatch = {
    ...batch,
    firmwareVersion,
    revision: batch.revision + 1,
    deviceIds: targetDeviceIds(group, batch.rolloutPercent, retained),
    ledger: [],
    heldReceipts: [],
    retainedResults: retained,
    failed: 0,
    updatedAt: at
  };
  return {
    ...state,
    batches: state.batches.map((item) => item.id === id ? recalculated : item),
    audits: withAudit(
      state,
      clock,
      actor,
      `批次 ${batch.name} 版本 ${batch.firmwareVersion} → ${firmwareVersion}：${droppedLedger} 台仅下载的未执行回执失效，${retained.length - batch.retainedResults.length} 台已安装结果保留，${droppedHeld} 条暂存回执作废，已按当前版本重算`
    )
  };
}

/** 把暂存回执按当前批次版本重放；旧版本或已离开目标集合的回执作废。 */
function applyHeldReceipts(batch: ReleaseBatch, clock: Clock): { batch: ReleaseBatch; replayed: number; dropped: number } {
  if (batch.heldReceipts.length === 0) return { batch: { ...batch, revision: batch.revision + 1, updatedAt: clock.now() }, replayed: 0, dropped: 0 };
  const seen = new Set(batch.seenReceiptIds);
  const ledger = [...batch.ledger];
  const byDevice = new Map(ledger.map((entry) => [entry.deviceId, entry]));
  let dropped = 0;
  let replayed = 0;
  const stillHeld: HeldReceipt[] = [];
  let revision = batch.revision;
  for (const held of [...batch.heldReceipts].sort((a, b) => a.receipt.at.localeCompare(b.receipt.at))) {
    const receipt = held.receipt;
    if (receipt.firmwareVersion !== batch.firmwareVersion || !batch.deviceIds.includes(receipt.deviceId)) {
      dropped += 1;
      continue;
    }
    const entry = byDevice.get(receipt.deviceId);
    const rank = STAGE_RANK[receipt.stage];
    if (entry && STAGE_RANK[entry.stage] >= rank) continue;
    const event: DeviceStageEvent = { stage: receipt.stage, at: receipt.at, receiptId: receipt.id };
    if (entry) {
      const merged: DeviceLedgerEntry = { ...entry, stage: receipt.stage, stages: [...entry.stages, event] };
      byDevice.set(receipt.deviceId, merged);
      const index = ledger.findIndex((item) => item.deviceId === receipt.deviceId);
      ledger[index] = merged;
    } else {
      const created: DeviceLedgerEntry = { deviceId: receipt.deviceId, firmwareVersion: receipt.firmwareVersion, stage: receipt.stage, stages: [event] };
      byDevice.set(receipt.deviceId, created);
      ledger.push(created);
    }
    revision += 1;
    replayed += 1;
  }
  return {
    batch: {
      ...batch,
      ledger,
      heldReceipts: stillHeld,
      seenReceiptIds: [...seen],
      revision: revision + (dropped > 0 ? 1 : 0),
      updatedAt: clock.now()
    },
    replayed,
    dropped
  };
}

export interface SubmitReceiptsInput {
  batchId: string;
  receipts: TelemetryReceipt[];
  baseRevision: number;
  actor?: string;
  store: ReceiptStore;
  /** 静默提交（遥测模拟）：不写逐条回执审计。 */
  silent?: boolean;
}

/**
 * 值班员提交一批遥测回执。
 *
 * - 重复回执（同号 / 同设备同阶段及以下 / 已失败待重试号）只出现一次；
 * - 修订号落后 → 冲突，返回冲突设备和最新批次修订号；
 * - 版本不符 → 立即作废（版本一旦变更即失效）；
 * - 批次不在运行 → 暂存（暂停/回滚的进度不会被离线晚到回执重新计入）；
 * - 存储失败：成功设备保留，失败设备可只重试未完成部分。
 */
export function submitReceipts(state: ReleaseState, input: SubmitReceiptsInput, clock: Clock = defaultClock): ReleaseState {
  const at = clock.now();
  const makeResult = (partial: Partial<ReceiptSubmitResult>): ReceiptSubmitResult => ({
    batchId: input.batchId,
    baseRevision: input.baseRevision,
    currentRevision: input.baseRevision,
    accepted: [],
    duplicates: [],
    staleVersion: [],
    held: [],
    storageFailed: [],
    conflicts: [],
    rejectedReadonly: false,
    notFound: false,
    at,
    ...partial
  });
  const batch = state.batches.find((item) => item.id === input.batchId);
  if (!batch) return { ...state, lastReceiptResult: makeResult({ notFound: true }) };
  if (batch.status === 'legacy_readonly') {
    return { ...state, lastReceiptResult: makeResult({ currentRevision: batch.revision, rejectedReadonly: true }) };
  }

  const receipts = [...input.receipts].sort((a, b) => a.at.localeCompare(b.at));
  const accepted: TelemetryReceipt[] = [];
  const duplicates: TelemetryReceipt[] = [];
  const staleVersion: TelemetryReceipt[] = [];
  const held: TelemetryReceipt[] = [];
  const conflicts: ReceiptConflict[] = [];

  // 后到提交者若基于旧修订号，先看到冲突设备和最新批次修订号（按设备去重）。
  if (input.baseRevision !== batch.revision) {
    const conflictDevices = new Map<string, ReceiptConflict>();
    for (const receipt of receipts) {
      if (conflictDevices.has(receipt.deviceId)) continue;
      const entry = batch.ledger.find((item) => item.deviceId === receipt.deviceId);
      conflictDevices.set(receipt.deviceId, {
        deviceId: receipt.deviceId,
        incomingStage: receipt.stage,
        currentStage: entry?.stage ?? null,
        baseRevision: input.baseRevision,
        currentRevision: batch.revision
      });
    }
    const conflicts = [...conflictDevices.values()];
    return {
      ...state,
      lastReceiptResult: makeResult({ currentRevision: batch.revision, conflicts }),
      audits: withAudit(state, clock, input.actor ?? '值班员', `批次 ${batch.name} 回执提交冲突：基于修订 ${input.baseRevision}，当前已为 ${batch.revision}，冲突设备 ${conflicts.length} 台`)
    };
  }

  let working = batch;
  // 本批已接受回执的设备阶段：同一批内同设备同阶段/倒退的不同号回执也算重复。
  const pendingRank = new Map<string, number>();
  for (const receipt of receipts) {
    if (working.seenReceiptIds.includes(receipt.id)) {
      duplicates.push(receipt);
      continue;
    }
    if (receipt.firmwareVersion !== working.firmwareVersion) {
      staleVersion.push(receipt);
      // 旧版本回执立即失效；记录其号，重复送达时仍只出现一次。
      working = { ...working, seenReceiptIds: [...working.seenReceiptIds, receipt.id] };
      continue;
    }
    if (!working.deviceIds.includes(receipt.deviceId)) {
      staleVersion.push(receipt);
      working = { ...working, seenReceiptIds: [...working.seenReceiptIds, receipt.id] };
      continue;
    }
    if (working.status !== 'running') {
      // 暂停/回滚/等候/完成：离线晚到回执只暂存，绝不重新计入进度。
      const heldEntry: HeldReceipt = { receipt, reason: 'batch_not_running', receivedAt: at };
      working = {
        ...working,
        heldReceipts: [...working.heldReceipts, heldEntry],
        seenReceiptIds: [...working.seenReceiptIds, receipt.id]
      };
      held.push(receipt);
      continue;
    }
    const entry = working.ledger.find((item) => item.deviceId === receipt.deviceId);
    const rank = STAGE_RANK[receipt.stage];
    const knownRank = Math.max(entry ? STAGE_RANK[entry.stage] : 0, pendingRank.get(receipt.deviceId) ?? 0);
    if (knownRank >= rank) {
      // 同设备阶段不允许倒退，重复阶段回执（含同一批内的不同号重报）只出现一次。
      duplicates.push(receipt);
      working = { ...working, seenReceiptIds: [...working.seenReceiptIds, receipt.id] };
      continue;
    }
    pendingRank.set(receipt.deviceId, rank);
    accepted.push(receipt);
  }

  // 存储：已完成设备不受影响；只对本次接受的回执落盘，失败部分原样保留以待重试。
  const failedIds = accepted.length > 0 ? input.store.commit(batch.id, accepted) : [];
  const failedSet = new Set(failedIds);
  const storageFailed = accepted.filter((receipt) => failedSet.has(receipt.id));
  const persisted = accepted.filter((receipt) => !failedSet.has(receipt.id));

  const byDevice = new Map(working.ledger.map((entry) => [entry.deviceId, entry]));
  const ledger = [...working.ledger];
  for (const receipt of persisted) {
    const event: DeviceStageEvent = { stage: receipt.stage, at: receipt.at, receiptId: receipt.id };
    const existing = byDevice.get(receipt.deviceId);
    if (existing) {
      const merged: DeviceLedgerEntry = { ...existing, stage: receipt.stage, stages: [...existing.stages, event] };
      byDevice.set(receipt.deviceId, merged);
      ledger[ledger.findIndex((item) => item.deviceId === receipt.deviceId)] = merged;
    } else {
      const created: DeviceLedgerEntry = { deviceId: receipt.deviceId, firmwareVersion: receipt.firmwareVersion, stage: receipt.stage, stages: [event] };
      byDevice.set(receipt.deviceId, created);
      ledger.push(created);
    }
  }
  const successCount = persisted.length;
  // 成功落盘的回执号进入全修订期去重索引；存储失败的不进入，保留重试机会。
  const storedBatch = touch(
    { ...working, ledger, seenReceiptIds: [...working.seenReceiptIds, ...persisted.map((receipt) => receipt.id)] },
    at,
    working.revision + successCount
  );

  const result: ReceiptSubmitResult = makeResult({
    currentRevision: storedBatch.revision,
    accepted: persisted,
    duplicates,
    staleVersion,
    held,
    conflicts,
    storageFailed
  });

  let next: ReleaseState = {
    ...state,
    batches: state.batches.map((item) => item.id === batch.id ? storedBatch : item),
    lastReceiptResult: result
  };

  const parts: string[] = [];
  if (persisted.length) parts.push(`入账 ${persisted.length} 条`);
  if (duplicates.length) parts.push(`重复 ${duplicates.length} 条`);
  if (staleVersion.length) parts.push(`版本失效 ${staleVersion.length} 条`);
  if (held.length) parts.push(`暂存 ${held.length} 条`);
  if (storageFailed.length) parts.push(`存储失败 ${storageFailed.length} 条（保留已完成设备，待重试未完成部分）`);
  if (parts.length && !input.silent) {
    next = { ...next, audits: withAudit(next, clock, input.actor ?? '值班员', `批次 ${batch.name} 回执提交：${parts.join('，')}`) };
  }
  // 全部目标设备重启完成才结束批次并释放窗口（下载/安装完成不算）。
  if (isFullyRebooted(storedBatch)) {
    next = completeBatch(next, batch.id, '系统', clock);
    const doneBatch = next.batches.find((item) => item.id === batch.id);
    if (doneBatch) {
      next = { ...next, lastReceiptResult: { ...result, currentRevision: doneBatch.revision } };
    }
  }
  return next;
}

/** 只重试上一次存储失败、至今仍未完成的设备回执。 */
export function retryPendingReceipts(state: ReleaseState, id: string, actor: string, store: ReceiptStore, clock: Clock = defaultClock): ReleaseState {
  const batch = state.batches.find((item) => item.id === id);
  const pending = state.lastReceiptResult?.storageFailed ?? [];
  if (!batch || pending.length === 0) return state;
  const currentStages = new Map(batch.ledger.map((entry) => [entry.deviceId, entry.stage]));
  const stillPending = pending.filter((receipt) => {
    if (receipt.firmwareVersion !== batch.firmwareVersion) return false;
    const stage = currentStages.get(receipt.deviceId);
    return stage === undefined || STAGE_RANK[stage] < STAGE_RANK[receipt.stage];
  });
  if (stillPending.length === 0) {
    return { ...state, lastReceiptResult: null, audits: withAudit(state, clock, actor, `批次 ${batch.name} 无待重试回执`) };
  }
  const cleared: ReleaseState = { ...state, lastReceiptResult: null };
  return submitReceipts(cleared, { batchId: id, receipts: stillPending, baseRevision: batch.revision, actor, store }, clock);
}

/** 由内存存储故障配置构造的存储端口：标记的设备落盘失败。 */
export function faultAwareStore(fault: ReleaseState['storageFault']): ReceiptStore {
  return {
    commit(_batchId, receipts) {
      if (!fault) return [];
      if (fault.failAll) return receipts.map((receipt) => receipt.id);
      return receipts.filter((receipt) => fault.deviceIds.includes(receipt.deviceId)).map((receipt) => receipt.id);
    }
  };
}

// ---- 账上派生指标（全部由当前版本设备账实时重算） ----

export function ledgerCounters(batch: ReleaseBatch): { downloaded: number; installed: number; rebooted: number; progress: number; target: number } {
  let downloaded = 0;
  let installed = 0;
  let rebooted = 0;
  for (const entry of batch.ledger) {
    downloaded += 1;
    if (STAGE_RANK[entry.stage] >= STAGE_RANK.installed) installed += 1;
    if (entry.stage === 'rebooted') rebooted += 1;
  }
  const target = batch.deviceIds.length;
  return { downloaded, installed, rebooted, target, progress: target ? Math.round(rebooted / target * 100) : 0 };
}

export function isReadonly(batch: ReleaseBatch): boolean {
  return batch.status === 'legacy_readonly';
}
