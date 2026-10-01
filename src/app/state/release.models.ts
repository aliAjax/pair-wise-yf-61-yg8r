export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back' | 'waiting';

/** 回执阶段：下载 → 安装 → 重启，权重递增 */
export type ReceiptStage = 'downloaded' | 'installed' | 'rebooted';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

/** 批次版本变更记录（用于版本一变即失效的审计） */
export interface VersionChange {
  version: string;
  at: string;
  actor: string;
  reason: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  downloaded: number;
  installed: number;
  rebooted: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  versionHistory: VersionChange[];
}

/**
 * 设备回执（账本的最小单元）。
 * 幂等键 = batchId + deviceId + stage + version，重复回执只出现一次。
 */
export interface DeviceReceipt {
  id: string;
  batchId: string;
  deviceId: string;
  stage: ReceiptStage;
  /** 回执产生时的固件版本，用于版本变更后判定失效 */
  version: string;
  at: string;
  actor: string;
}

/** 乐观并发冲突：后提交者看到的冲突设备与最新批次 */
export interface ReceiptConflict {
  batchId: string;
  /** 关联到具体提交者，便于值班员各自看到自己的冲突 */
  clientId: string;
  at: string;
  actor: string;
  baseRevision: number;
  serverRevision: number;
  /** 与先到回执撞车的设备号 */
  conflictingDevices: string[];
  /** 最新批次快照（已按当前账本重算） */
  latestBatch: ReleaseBatch;
  message: string;
}

/** 持久化失败后待重试的回执（只重试未完成部分） */
export interface PendingWrite {
  receipt: DeviceReceipt;
  attempts: number;
  lastError: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  /** 账本结构版本；缺少该字段的旧数据升级为历史只读 */
  schemaVersion: number;
  /** 旧数据升级后标记为只读，禁止任何写入 */
  readOnly: boolean;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  /** 追加式回执账本 */
  receipts: DeviceReceipt[];
  /** 乐观并发令牌，每次账本变更递增 */
  ledgerRevision: number;
  lastConflict: ReceiptConflict | null;
  pendingWrites: PendingWrite[];
  storageStatus: 'ok' | 'degraded';
}

export const RECEIPT_STAGES: ReceiptStage[] = ['downloaded', 'installed', 'rebooted'];

export const STAGE_WEIGHT: Record<ReceiptStage, number> = {
  downloaded: 1,
  installed: 2,
  rebooted: 3
};

/** 占用发布窗口的状态：运行中或已暂停（未到终态） */
export function occupiesWindow(status: BatchStatus): boolean {
  return status === 'running' || status === 'paused';
}

/** 终态：完成或已回滚，窗口释放 */
export function isTerminal(status: BatchStatus): boolean {
  return status === 'completed' || status === 'rolled_back';
}
