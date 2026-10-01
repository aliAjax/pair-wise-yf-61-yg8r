export type DeviceStage = 'downloaded' | 'installed' | 'rebooted';

export type BatchStatus =
  | 'draft'
  | 'approved'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'rolled_back'
  | 'legacy_readonly';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

/** 一次遥测回执：某台设备在某批次上报的一个阶段完成事件。 */
export interface TelemetryReceipt {
  id: string;
  batchId: string;
  deviceId: string;
  stage: DeviceStage;
  firmwareVersion: string;
  at: string;
}

/** 设备在某个批次版本下走过的单个阶段事件。 */
export interface DeviceStageEvent {
  stage: DeviceStage;
  at: string;
  receiptId: string;
}

/**
 * 批次设备账：按设备号记账，每个设备只出现一条，
 * stages 依次留存下载、安装、重启事件；重复回执不会产生第二条。
 */
export interface DeviceLedgerEntry {
  deviceId: string;
  firmwareVersion: string;
  stage: DeviceStage;
  stages: DeviceStageEvent[];
}

/** 已到达但当前不能计入的回执（批次暂停/回滚/等候/完成等）。 */
export interface HeldReceipt {
  receipt: TelemetryReceipt;
  reason: 'batch_not_running';
  receivedAt: string;
}

/** 版本变更后仍保留的已安装设备结果（历史只读）。 */
export interface RetainedDeviceResult {
  deviceId: string;
  firmwareVersion: string;
  stage: DeviceStage;
  stages: DeviceStageEvent[];
  retainedAt: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmwareVersion: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  /** 乐观并发修订号：版本变化、状态流转、成功入账都会递增；并发提交据此发现冲突。 */
  revision: number;
  deviceIds: string[];
  ledger: DeviceLedgerEntry[];
  heldReceipts: HeldReceipt[];
  retainedResults: RetainedDeviceResult[];
  /** 全修订期去重索引：同一条回执永远只生效/出现一次。 */
  seenReceiptIds: string[];
  failed: number;
  legacyMissingVersion?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

/** 存储端口：返回未能落盘的回执号，调用方只重试这部分。 */
export interface ReceiptStore {
  commit(batchId: string, receipts: TelemetryReceipt[]): string[];
}

export interface StorageFaultConfig {
  failAll: boolean;
  deviceIds: string[];
}

export interface ReleaseState {
  schemaVersion: 2;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  storageFault: StorageFaultConfig | null;
  lastReceiptResult: ReceiptSubmitResult | null;
}

export interface ReceiptConflict {
  deviceId: string;
  incomingStage: DeviceStage;
  currentStage: DeviceStage | null;
  baseRevision: number;
  currentRevision: number;
}

export interface ReceiptSubmitResult {
  batchId: string;
  baseRevision: number;
  currentRevision: number;
  accepted: TelemetryReceipt[];
  duplicates: TelemetryReceipt[];
  staleVersion: TelemetryReceipt[];
  held: TelemetryReceipt[];
  conflicts: ReceiptConflict[];
  storageFailed: TelemetryReceipt[];
  rejectedReadonly: boolean;
  notFound: boolean;
  at: string;
}
