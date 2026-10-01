import type {
  AuditEntry,
  DeviceGroup,
  DeviceLedgerEntry,
  DeviceStage,
  ReleaseBatch,
  ReleaseState
} from './release.models';
import { deviceId, targetDeviceIds } from './release.ledger';

export const STORAGE_KEY_V1 = 'firmware-release-v1';
export const STORAGE_KEY_V2 = 'firmware-release-v2';

const seedGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];

function seedEntry(device: string, firmwareVersion: string, stage: DeviceStage, at: string): DeviceLedgerEntry {
  const stages: DeviceLedgerEntry['stages'] = [{ stage: 'downloaded', at, receiptId: `seed-${device}-downloaded` }];
  if (stage === 'installed' || stage === 'rebooted') stages.push({ stage: 'installed', at, receiptId: `seed-${device}-installed` });
  if (stage === 'rebooted') stages.push({ stage: 'rebooted', at, receiptId: `seed-${device}-rebooted` });
  return { deviceId: device, firmwareVersion, stage, stages };
}

/** v1 旧账缺少批次版本字段：整体升级为历史只读，不允许再提交回执或流转。 */
export function migrateV1(raw: unknown): ReleaseState | null {
  if (!raw || typeof raw !== 'object') return null;
  const old = raw as { groups?: DeviceGroup[]; batches?: Array<Record<string, unknown>>; audits?: AuditEntry[] };
  if (!Array.isArray(old.batches)) return null;
  const at = new Date().toISOString();
  const groups = Array.isArray(old.groups) && old.groups.length ? old.groups : seedGroups;
  const batches: ReleaseBatch[] = old.batches.map((b, index) => {
    const groupId = typeof b['groupId'] === 'string' ? b['groupId'] : groups[0]?.id ?? 'g-edge';
    const firmwareVersion = typeof b['firmware'] === 'string' ? b['firmware'] : '未知（历史版本）';
    const id = typeof b['id'] === 'string' ? b['id'] : `legacy-${index}`;
    const group = groups.find((item) => item.id === groupId);
    const rolloutPercent = typeof b['rolloutPercent'] === 'number' ? b['rolloutPercent'] : 0;
    return {
      id,
      name: typeof b['name'] === 'string' ? b['name'] : `历史批次 ${index + 1}`,
      firmwareVersion,
      rollbackVersion: typeof b['rollbackVersion'] === 'string' ? b['rollbackVersion'] : '',
      groupId,
      rolloutPercent,
      failureThreshold: typeof b['failureThreshold'] === 'number' ? b['failureThreshold'] : 0,
      status: 'legacy_readonly',
      revision: 0,
      deviceIds: targetDeviceIds(group, rolloutPercent),
      ledger: [],
      heldReceipts: [],
      retainedResults: [],
      seenReceiptIds: [],
      failed: typeof b['failed'] === 'number' ? b['failed'] : 0,
      legacyMissingVersion: typeof b['firmware'] !== 'string',
      createdAt: typeof b['updatedAt'] === 'string' ? b['updatedAt'] : at,
      updatedAt: at
    } satisfies ReleaseBatch;
  });
  const audits: AuditEntry[] = [
    {
      id: 'migration-v1-v2',
      at,
      actor: '系统',
      message: `检测到 ${batches.length} 个缺少版本字段的旧批次，已升级为历史只读，旧账仅可查看`
    },
    ...(Array.isArray(old.audits) ? old.audits : [])
  ];
  return { schemaVersion: 2, groups, batches, audits, storageFault: null, lastReceiptResult: null };
}

export function seedState(): ReleaseState {
  const at = new Date().toISOString();
  const edge = seedGroups[0];
  const edgeTarget = targetDeviceIds(edge, 20);
  const running: ReleaseBatch = {
    id: 'batch-edge-281',
    name: '边缘网关安全补丁 2.8.1',
    firmwareVersion: '2.8.1',
    rollbackVersion: '2.7.9',
    groupId: 'g-edge',
    rolloutPercent: 20,
    failureThreshold: 5,
    status: 'running',
    revision: 4,
    deviceIds: edgeTarget,
    ledger: [
      seedEntry(deviceId('g-edge', 0), '2.8.1', 'rebooted', at),
      seedEntry(deviceId('g-edge', 1), '2.8.1', 'installed', at),
      seedEntry(deviceId('g-edge', 2), '2.8.1', 'downloaded', at)
    ],
    heldReceipts: [],
    retainedResults: [],
    seenReceiptIds: [
      `seed-${deviceId('g-edge', 0)}-downloaded`,
      `seed-${deviceId('g-edge', 0)}-installed`,
      `seed-${deviceId('g-edge', 0)}-rebooted`,
      `seed-${deviceId('g-edge', 1)}-downloaded`,
      `seed-${deviceId('g-edge', 1)}-installed`,
      `seed-${deviceId('g-edge', 2)}-downloaded`
    ],
    failed: 0,
    createdAt: at,
    updatedAt: at
  };
  const waiting: ReleaseBatch = {
    id: 'batch-edge-300',
    name: '边缘网关 3.0.0 灰度',
    firmwareVersion: '3.0.0',
    rollbackVersion: '2.9.2',
    groupId: 'g-edge',
    rolloutPercent: 10,
    failureThreshold: 3,
    status: 'waiting',
    revision: 1,
    deviceIds: targetDeviceIds(edge, 10),
    ledger: [],
    heldReceipts: [],
    retainedResults: [],
    seenReceiptIds: [],
    failed: 0,
    createdAt: at,
    updatedAt: at
  };
  const legacy: ReleaseBatch = {
    id: 'batch-legacy',
    name: '旧平台补丁批次（迁移）',
    firmwareVersion: '未知（历史版本）',
    rollbackVersion: '',
    groupId: 'g-clinic',
    rolloutPercent: 0,
    failureThreshold: 0,
    status: 'legacy_readonly',
    revision: 0,
    deviceIds: [],
    ledger: [],
    heldReceipts: [],
    retainedResults: [],
    seenReceiptIds: [],
    failed: 7,
    legacyMissingVersion: true,
    createdAt: at,
    updatedAt: at
  };
  const audits: AuditEntry[] = [
    { id: 'audit-seed-1', at, actor: '运维值班', message: '批次 边缘网关安全补丁 2.8.1 占用分组 g-edge 发布窗口，发布中' },
    { id: 'audit-seed-2', at, actor: '系统', message: '批次 边缘网关 3.0.0 灰度 因窗口占用进入等候队列' },
    { id: 'audit-seed-3', at, actor: '系统', message: '检测到 1 个缺少版本字段的旧批次，已升级为历史只读，旧账仅可查看' }
  ];
  return { schemaVersion: 2, groups: seedGroups, batches: [waiting, running, legacy], audits, storageFault: null, lastReceiptResult: null };
}

/**
 * 可恢复启动：优先读取 v2 账；不存在时尝试把 v1 旧账升级为历史只读；
 * 都没有则使用演示种子。任何解析失败都回落到种子，保证控制台可用。
 */
export function loadInitialState(): ReleaseState {
  if (typeof localStorage === 'undefined') return seedState();
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as ReleaseState;
      if (parsed && parsed.schemaVersion === 2 && Array.isArray(parsed.batches)) {
        return { ...seedState(), ...parsed, lastReceiptResult: parsed.lastReceiptResult ?? null };
      }
    }
    const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const migrated = migrateV1(JSON.parse(rawV1) as unknown);
      if (migrated) return migrated;
    }
  } catch {
    // 损坏的本地账不阻断启动。
  }
  return seedState();
}
