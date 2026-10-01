import assert = require('node:assert/strict');
import { test } from 'node:test';
import type {
  DeviceStage,
  ReceiptStore,
  ReleaseState,
  TelemetryReceipt
} from './release.models';
import {
  changeBatchVersion,
  createBatch,
  deviceId,
  ledgerCounters,
  pauseBatch,
  resumeBatch,
  retryPendingReceipts,
  rollbackBatch,
  startBatch,
  submitReceipts
} from './release.ledger';
import { migrateV1, seedState } from './release.storage';

// ---- 测试夹具 ----

function testState(): ReleaseState {
  const seed = seedState();
  return { ...seed, batches: [], audits: [], lastReceiptResult: null, storageFault: null };
}

function makeClock(seed = 1) {
  let seq = seed;
  return {
    now: () => new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
    uuid: () => `id-${seq++}`
  };
}

function receipt(batchId: string, deviceIndex: number, stage: DeviceStage, version: string, seq: number): TelemetryReceipt {
  return {
    id: `r-${seq}`,
    batchId,
    deviceId: deviceId('g-edge', deviceIndex),
    stage,
    firmwareVersion: version,
    at: `2026-10-01T0${seq}:00:00.000Z`
  };
}

function alwaysFailStore(): ReceiptStore {
  return { commit: (_batchId, receipts) => receipts.map((item) => item.id) };
}
function selectiveFailStore(failedIds: Set<string>): ReceiptStore {
  return { commit: (_batchId, receipts) => receipts.filter((item) => failedIds.has(item.id)).map((item) => item.id) };
}

function prepareRunningBatch(state: ReleaseState): { state: ReleaseState; id: string; revision: number } {
  const clock = makeClock(100);
  let next = createBatch(state, {
    name: '测试批次',
    firmwareVersion: '1.0.0',
    rollbackVersion: '0.9.0',
    groupId: 'g-edge',
    rolloutPercent: 10,
    failureThreshold: 50
  }, clock);
  const id = next.batches[0]!.id;
  next = startBatch(next, id, '值班员', clock);
  const revision = next.batches[0]!.revision;
  return { state: next, id, revision };
}

// ---- 1. 每批按设备号记账，重复回执只出现一次 ----

test('设备账按设备号记录下载/安装/重启，重复回执只生效一次', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(200);

  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    actor: '值班员A',
    store: { commit: () => [] },
    receipts: [
      receipt(id, 0, 'downloaded', '1.0.0', 1),
      receipt(id, 0, 'installed', '1.0.0', 2),
      receipt(id, 0, 'rebooted', '1.0.0', 3)
    ]
  }, clock);
  let batch = state.batches[0]!;
  assert.equal(batch.ledger.length, 1, '同一台设备只有一条账');
  assert.deepEqual(batch.ledger[0]!.stages.map((s) => s.stage), ['downloaded', 'installed', 'rebooted']);
  assert.equal(batch.ledger[0]!.stage, 'rebooted');

  // 同号回执重放 + 阶段倒退：均为重复，不产生新事件，修订号不变。
  const revisionBefore = batch.revision;
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: revisionBefore,
    actor: '值班员A',
    store: { commit: () => [] },
    receipts: [
      { ...receipt(id, 0, 'rebooted', '1.0.0', 3) },
      receipt(id, 0, 'downloaded', '1.0.0', 4)
    ]
  }, clock);
  batch = state.batches[0]!;
  assert.equal(batch.ledger.length, 1);
  assert.equal(batch.ledger[0]!.stages.length, 3);
  assert.equal(batch.revision, revisionBefore, '重复回执不推进修订号');
  assert.deepEqual(state.lastReceiptResult!.duplicates.map((r) => r.id), ['r-3', 'r-4']);

  // 指标由账重算。
  const counters = ledgerCounters(batch);
  assert.equal(counters.downloaded, 1);
  assert.equal(counters.installed, 1);
  assert.equal(counters.rebooted, 1);
});

test('同一批内不同号但同设备同阶段的回执只入账一条', () => {
  const prepared = prepareRunningBatch(testState());
  const state0 = submitReceipts(prepared.state, {
    batchId: prepared.id,
    baseRevision: prepared.revision,
    store: { commit: () => [] },
    receipts: [
      { ...receipt(prepared.id, 1, 'downloaded', '1.0.0', 101), at: '2026-10-01T01:01:00.000Z' },
      { ...receipt(prepared.id, 1, 'downloaded', '1.0.0', 102), at: '2026-10-01T01:02:00.000Z' },
      // 阶段倒退同样被吞。
      { ...receipt(prepared.id, 1, 'downloaded', '1.0.0', 103), at: '2026-10-01T01:03:00.000Z' }
    ]
  }, makeClock(150));
  const batch = state0.batches[0]!;
  assert.equal(batch.ledger.length, 1);
  assert.equal(batch.ledger[0]!.stages.length, 1, '设备只记录一个下载事件');
  assert.equal(state0.lastReceiptResult!.accepted.length, 1);
  assert.equal(state0.lastReceiptResult!.duplicates.length, 2);
  assert.ok(batch.seenReceiptIds.includes('r-101'), '成功回执进入去重索引');
});

// ---- 2. 暂停/回滚后晚到的离线回执不重新计入 ----

test('暂停后晚到回执只暂存不计账，恢复时按当前版本重放', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(300);

  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: { commit: () => [] },
    receipts: [receipt(id, 0, 'downloaded', '1.0.0', 10)]
  }, clock);
  state = pauseBatch(state, id, '值班员', clock);
  assert.equal(state.batches[0]!.status, 'paused');
  const countersPaused = ledgerCounters(state.batches[0]!);

  // 暂停期间两台设备的离线回执晚到。
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: { commit: () => [] },
    receipts: [
      receipt(id, 0, 'installed', '1.0.0', 11),
      receipt(id, 1, 'downloaded', '1.0.0', 12)
    ]
  }, clock);
  const pausedBatch = state.batches[0]!;
  assert.equal(pausedBatch.heldReceipts.length, 2, '晚到回执进入暂存');
  assert.deepEqual(ledgerCounters(pausedBatch), countersPaused, '暂停中的进度不被重新计入');

  state = resumeBatch(state, id, '运维', clock);
  const resumed = state.batches[0]!;
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.heldReceipts.length, 0, '恢复后暂存清空');
  assert.equal(resumed.ledger.length, 2, '两台设备已按当前版本入账');
  assert.equal(ledgerCounters(resumed).installed, 1);
});

test('回滚后晚到回执只暂存，永不计账且不自动提升', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(400);

  state = rollbackBatch(state, id, '发布负责人', clock);
  assert.equal(state.batches[0]!.status, 'rolled_back');
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: { commit: () => [] },
    receipts: [receipt(id, 5, 'downloaded', '1.0.0', 20)]
  }, clock);
  const rolled = state.batches[0]!;
  assert.equal(rolled.heldReceipts.length, 1);
  assert.equal(rolled.ledger.length, 0);
  assert.equal(ledgerCounters(rolled).downloaded, 0, '回滚批次进度不被晚到回执计入');
});

// ---- 3. 分组窗口占用与等候队列 ----

test('分组被占用时新批次等候，占用者回滚后自动接管窗口', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const firstId = prepared.id;
  const clock = makeClock(500);

  state = createBatch(state, {
    name: '第二批次',
    firmwareVersion: '2.0.0',
    rollbackVersion: '1.9.0',
    groupId: 'g-edge',
    rolloutPercent: 10,
    failureThreshold: 50
  }, clock);
  const secondId = state.batches[0]!.id;
  assert.equal(state.batches.find((b) => b.id === secondId)!.status, 'waiting', '创建时窗口被占，直接等候');

  // 等候批次尝试开始，仍是等候。
  state = startBatch(state, secondId, '值班员', clock);
  assert.equal(state.batches.find((b) => b.id === secondId)!.status, 'waiting');

  // 给等候批次先留一条离线回执（将在接管窗口时重放）。
  state = submitReceipts(state, {
    batchId: secondId,
    baseRevision: state.batches.find((b) => b.id === secondId)!.revision,
    store: { commit: () => [] },
    receipts: [receipt(secondId, 0, 'downloaded', '2.0.0', 30)]
  }, clock);
  assert.equal(state.batches.find((b) => b.id === secondId)!.heldReceipts.length, 1);

  // 第一个批次回滚 → 第二个自动 running。
  state = rollbackBatch(state, firstId, '发布负责人', clock);
  const promoted = state.batches.find((b) => b.id === secondId)!;
  assert.equal(promoted.status, 'running');
  assert.equal(promoted.heldReceipts.length, 0);
  assert.equal(promoted.ledger.length, 1, '接管窗口时重放暂存回执');
});

// ---- 4. 批次版本一变，未执行回执立即失效并按当前版本重算，已安装保留 ----

test('版本变更：仅下载的回执失效，已安装设备保留结果且不进新目标', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(600);

  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: { commit: () => [] },
    receipts: [
      receipt(id, 0, 'rebooted', '1.0.0', 40),
      receipt(id, 1, 'installed', '1.0.0', 41),
      receipt(id, 2, 'downloaded', '1.0.0', 42),
      receipt(id, 3, 'downloaded', '1.0.0', 43)
    ]
  }, clock);

  state = changeBatchVersion(state, id, '1.1.0', '发布负责人', clock);
  const changed = state.batches[0]!;
  assert.equal(changed.firmwareVersion, '1.1.0');
  assert.equal(changed.ledger.length, 0, '新账本从当前版本重新开始');
  assert.equal(changed.retainedResults.length, 2, '已安装/重启的两台设备结果保留');
  assert.ok(!changed.deviceIds.includes(deviceId('g-edge', 0)), '保留设备不进入新版本目标');
  assert.ok(!changed.deviceIds.includes(deviceId('g-edge', 1)));
  assert.ok(changed.deviceIds.includes(deviceId('g-edge', 2)), '仅下载设备仍是新版本目标');
  assert.equal(ledgerCounters(changed).downloaded, 0, '进度只按当前版本重算');

  // 旧版本晚到回执立即失效，不再出现第二次。
  const revision = changed.revision;
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: revision,
    store: { commit: () => [] },
    receipts: [
      receipt(id, 2, 'installed', '1.0.0', 44),
      receipt(id, 2, 'installed', '1.0.0', 44)
    ]
  }, clock);
  const afterStale = state.batches[0]!;
  assert.equal(afterStale.ledger.length, 0);
  assert.equal(state.lastReceiptResult!.staleVersion.length, 1, '同一条旧版本回执重复送达也只出现一次');
  assert.equal(afterStale.seenReceiptIds.includes('r-44'), true);
});

// ---- 5. 两名值班员并发提交：后到者看到冲突设备和最新批次 ----

test('并发提交：修订号落后的提交被拒，返回冲突设备与最新修订号', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(700);
  const baseRevision = state.batches[0]!.revision;

  // 值班员 A 先提交成功，修订号前进。
  state = submitReceipts(state, {
    batchId: id,
    baseRevision,
    actor: '值班员A',
    store: { commit: () => [] },
    receipts: [receipt(id, 0, 'downloaded', '1.0.0', 50)]
  }, clock);
  assert.equal(state.batches[0]!.revision, baseRevision + 1);

  // 值班员 B 手里仍是旧修订号，同时提交同一台设备。
  state = submitReceipts(state, {
    batchId: id,
    baseRevision,
    actor: '值班员B',
    store: { commit: () => [] },
    receipts: [receipt(id, 0, 'installed', '1.0.0', 51)]
  }, clock);
  const result = state.lastReceiptResult!;
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.deviceId, deviceId('g-edge', 0));
  assert.equal(result.conflicts[0]!.currentStage, 'downloaded', '冲突里带回设备当前阶段');
  assert.equal(result.currentRevision, baseRevision + 1, '冲突结果返回最新修订号');
  assert.equal(result.baseRevision, baseRevision);
  assert.equal(state.batches[0]!.ledger[0]!.stage, 'downloaded', '冲突提交未改动账本');

  // B 同步最新修订号后重新提交，成功。
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: result.currentRevision,
    actor: '值班员B',
    store: { commit: () => [] },
    receipts: [receipt(id, 0, 'installed', '1.0.0', 51)]
  }, clock);
  assert.equal(state.batches[0]!.ledger[0]!.stage, 'installed');
});

// ---- 6. 存储失败：保留已完成设备，只重试未完成部分 ----

test('存储部分失败：成功设备保留，重试只处理未完成回执', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(800);

  const r1 = receipt(id, 0, 'downloaded', '1.0.0', 60);
  const r2 = receipt(id, 1, 'downloaded', '1.0.0', 61);
  const r3 = receipt(id, 2, 'downloaded', '1.0.0', 62);
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    actor: '值班员A',
    store: selectiveFailStore(new Set(['r-62'])),
    receipts: [r1, r2, r3]
  }, clock);
  const batchAfterFailure = state.batches[0]!;
  assert.equal(batchAfterFailure.ledger.length, 2, '两台成功设备已保留');
  assert.deepEqual(state.lastReceiptResult!.storageFailed.map((r) => r.id), ['r-62']);

  // 存储仍失败：重试不重复提交已完成的两台。
  const seenFail: string[] = [];
  const probeStore: ReceiptStore = {
    commit: (_batchId, receipts) => {
      seenFail.push(...receipts.map((r) => r.id));
      return receipts.map((r) => r.id);
    }
  };
  state = retryPendingReceipts(state, id, '值班员A', probeStore, clock);
  assert.deepEqual(seenFail, ['r-62'], '只重试未完成的那一条');
  assert.equal(state.batches[0]!.ledger.length, 2);

  // 故障恢复后再次重试，未完成设备补齐。
  state = retryPendingReceipts(state, id, '值班员A', { commit: () => [] }, clock);
  assert.equal(state.batches[0]!.ledger.length, 3);
  assert.equal(state.lastReceiptResult!.accepted.length, 1, '重试成功返回入账结果');
  assert.equal(state.lastReceiptResult!.storageFailed.length, 0);
});

test('存储全部失败时账本不丢已有结果', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const id = prepared.id;
  const clock = makeClock(900);

  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: { commit: () => [] },
    receipts: [receipt(id, 0, 'rebooted', '1.0.0', 70)]
  }, clock);
  state = submitReceipts(state, {
    batchId: id,
    baseRevision: state.batches[0]!.revision,
    store: alwaysFailStore(),
    receipts: [receipt(id, 1, 'downloaded', '1.0.0', 71), receipt(id, 2, 'downloaded', '1.0.0', 72)]
  }, clock);
  const batch = state.batches[0]!;
  assert.equal(batch.ledger.length, 1, '此前完成的设备仍保留');
  assert.equal(state.lastReceiptResult!.storageFailed.length, 2);
});

// ---- 完成释放窗口：全部目标设备重启后结束，等候批次接管 ----

test('全部目标设备重启完成后批次结束并释放窗口给等候者', () => {
  const prepared = prepareRunningBatch(testState());
  let state = prepared.state;
  const firstId = prepared.id;
  const clock = makeClock(1100);
  const targetCount = state.batches[0]!.deviceIds.length;

  state = createBatch(state, {
    name: '后续批次',
    firmwareVersion: '2.0.0',
    rollbackVersion: '1.9.0',
    groupId: 'g-edge',
    rolloutPercent: 5,
    failureThreshold: 50
  }, clock);
  const secondId = state.batches[0]!.id;

  // 逐台完成 下载→安装→重启。
  const stages: DeviceStage[] = ['downloaded', 'installed', 'rebooted'];
  let seq = 1000;
  for (let i = 0; i < targetCount; i++) {
    for (const stage of stages) {
      state = submitReceipts(state, {
        batchId: firstId,
        baseRevision: state.batches.find((b) => b.id === firstId)!.revision,
        store: { commit: () => [] },
        receipts: [receipt(firstId, i, stage, '1.0.0', seq++)]
      }, clock);
    }
  }
  const done = state.batches.find((b) => b.id === firstId)!;
  assert.equal(done.status, 'completed', '全部重启后自动完成');
  assert.equal(ledgerCounters(done).progress, 100);
  const promoted = state.batches.find((b) => b.id === secondId)!;
  assert.equal(promoted.status, 'running', '窗口释放后等候者自动接管');
});

// ---- 7. 旧数据缺少版本：升级为历史只读 ----

test('v1 旧账升级为历史只读，拒绝任何回执与版本变更', () => {
  const migrated = migrateV1({
    groups: seedState().groups,
    batches: [{ id: 'old-1', name: '旧批次', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'running', progress: 80, downloaded: 100, failed: 3, updatedAt: '2025-12-01T00:00:00.000Z' }],
    audits: []
  })!;
  assert.equal(migrated.schemaVersion, 2);
  const legacy = migrated.batches[0]!;
  assert.equal(legacy.status, 'legacy_readonly');
  assert.equal(legacy.legacyMissingVersion, true, '旧固件字段 firmware 缺失时标记版本缺失');
  assert.equal(legacy.firmwareVersion, '未知（历史版本）');

  const clock = makeClock(1000);
  const afterSubmit = submitReceipts(migrated, {
    batchId: 'old-1',
    baseRevision: 0,
    store: { commit: () => [] },
    receipts: [receipt('old-1', 0, 'downloaded', '未知（历史版本）', 80)]
  }, clock);
  assert.equal(afterSubmit.lastReceiptResult!.rejectedReadonly, true);
  assert.equal(afterSubmit.batches[0]!.ledger.length, 0);

  const afterVersion = changeBatchVersion(migrated, 'old-1', '9.9.9', '发布负责人', clock);
  assert.equal(afterVersion.batches[0]!.firmwareVersion, '未知（历史版本）');

  const afterStart = startBatch(migrated, 'old-1', '值班员', clock);
  assert.equal(afterStart.batches[0]!.status, 'legacy_readonly');
});

test('旧账若带 firmware 字段也整体只读，不伪造缺失标记', () => {
  const migrated = migrateV1({
    groups: seedState().groups,
    batches: [{ id: 'old-2', name: '旧批次', firmware: '0.8.0', groupId: 'g-clinic', rolloutPercent: 0, failureThreshold: 0 }],
    audits: []
  })!;
  assert.equal(migrated.batches[0]!.status, 'legacy_readonly');
  assert.equal(migrated.batches[0]!.firmwareVersion, '0.8.0');
  assert.equal(migrated.batches[0]!.legacyMissingVersion ?? false, false);
});
