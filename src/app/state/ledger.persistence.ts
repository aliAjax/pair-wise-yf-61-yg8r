import { Injectable, computed, signal } from '@angular/core';
import type { DeviceReceipt, ReleaseState } from './release.models';

/**
 * 可恢复发布账的持久化层。
 *
 * 设计要点：
 * - 回执采用追加式日志，每条回执独立一个键，单条写入失败不影响其它已完成设备；
 * - 失败的回执进入 pendingWrites，恢复后只重试未完成部分；
 * - 旧版本（缺少 schemaVersion）数据加载时升级为历史只读。
 */

const META_KEY = 'firmware-ledger-v2:meta';
const LEGACY_KEY = 'firmware-release-v1';
const receiptKey = (id: string) => `firmware-ledger-v2:r:${id}`;

export function loadStateFromStorage(): ReleaseState | null {
  if (typeof localStorage === 'undefined') return null;

  const metaRaw = localStorage.getItem(META_KEY);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as Partial<ReleaseState>;
      const receipts: DeviceReceipt[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('firmware-ledger-v2:r:')) {
          try {
            receipts.push(JSON.parse(localStorage.getItem(key) ?? 'null') as DeviceReceipt);
          } catch {
            // 单条回执损坏不影响其它设备
          }
        }
      }
      receipts.sort((a, b) => a.at.localeCompare(b.at));
      return {
        ...EMPTY_STATE,
        schemaVersion: meta.schemaVersion ?? 2,
        readOnly: meta.readOnly ?? false,
        groups: meta.groups ?? [],
        batches: meta.batches ?? [],
        audits: meta.audits ?? [],
        receipts,
        ledgerRevision: meta.ledgerRevision ?? 0
      };
    } catch {
      // meta 损坏，回退到旧数据迁移
    }
  }

  // 旧版本数据：缺少 schemaVersion，升级为历史只读
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as Partial<ReleaseState>;
      return {
        ...EMPTY_STATE,
        readOnly: true,
        groups: legacy.groups ?? [],
        batches: legacy.batches ?? [],
        audits: legacy.audits ?? []
      };
    } catch {
      // 旧数据也损坏，返回空账本
    }
  }

  return null;
}

const EMPTY_STATE: ReleaseState = {
  schemaVersion: 2,
  readOnly: false,
  groups: [],
  batches: [],
  audits: [],
  receipts: [],
  ledgerRevision: 0,
  lastConflict: null,
  pendingWrites: [],
  storageStatus: 'ok'
};

@Injectable({ providedIn: 'root' })
export class LedgerPersistence {
  private readonly pending = new Map<string, DeviceReceipt>();
  private readonly faultInjected = signal(false);
  private readonly status = signal<'ok' | 'degraded'>('ok');
  readonly storageStatus = this.status.asReadonly();
  readonly pendingCount = computed(() => this.pending.size);
  readonly faultEnabled = this.faultInjected.asReadonly();

  /** 模拟存储故障（用于演示“存储失败后只重试未完成部分”） */
  setFault(enabled: boolean): void {
    this.faultInjected.set(enabled);
    if (!enabled) this.retryPending();
  }

  persistMeta(state: ReleaseState): void {
    if (this.faultInjected()) {
      this.status.set('degraded');
      return;
    }
    try {
      const meta = {
        schemaVersion: state.schemaVersion,
        ledgerRevision: state.ledgerRevision,
        readOnly: state.readOnly,
        groups: state.groups,
        batches: state.batches,
        audits: state.audits
      };
      localStorage.setItem(META_KEY, JSON.stringify(meta));
      if (this.pending.size === 0) this.status.set('ok');
    } catch {
      this.status.set('degraded');
    }
  }

  persistReceipt(receipt: DeviceReceipt): void {
    if (this.faultInjected()) {
      this.pending.set(receipt.id, receipt);
      this.status.set('degraded');
      return;
    }
    try {
      localStorage.setItem(receiptKey(receipt.id), JSON.stringify(receipt));
      this.pending.delete(receipt.id);
      if (this.pending.size === 0) this.status.set('ok');
    } catch {
      this.pending.set(receipt.id, receipt);
      this.status.set('degraded');
    }
  }

  /** 只重试未完成的回执，已落盘的设备不动 */
  retryPending(): void {
    if (this.faultInjected()) return;
    for (const [id, receipt] of this.pending) {
      try {
        localStorage.setItem(receiptKey(id), JSON.stringify(receipt));
        this.pending.delete(id);
      } catch {
        // 仍失败，保留待下次重试
      }
    }
    if (this.pending.size === 0) this.status.set('ok');
  }
}
