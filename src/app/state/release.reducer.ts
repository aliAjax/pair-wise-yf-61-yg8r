import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, ReleaseBatch, ReleaseState } from './release.models';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick } from './release.actions';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];
const now = new Date().toISOString();
const initialBatches: ReleaseBatch[] = [
  { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: now }
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];
const STORAGE_KEY = 'firmware-release-v1';
const fallback: ReleaseState = { groups: initialGroups, batches: initialBatches, audits: initialAudits };
const stored = typeof localStorage === 'undefined' ? fallback : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
const initialState = stored ?? fallback;

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => ({ ...state, batches: [batch, ...state.batches], audits: audit(state, '发布负责人', `创建批次 ${batch.name}`) })),
  on(approveBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 审批通过`) })),
  on(pauseBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 已暂停`) })),
  on(resumeBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 恢复发布`) })),
  on(rollbackBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'rolled_back', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 已紧急回滚`) })),
  on(telemetryTick, (state) => {
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
      const increment = Math.max(4, Math.round(target * 0.055));
      const downloaded = Math.min(target, batch.downloaded + increment);
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold ? 'paused' : downloaded >= target ? 'completed' : 'running';
      return { ...batch, downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0, status, updatedAt: new Date().toISOString() };
    });
    const overflow = batches.some((batch, index) => batch.status === 'paused' && state.batches[index]?.status === 'running');
    return { ...state, batches, audits: overflow ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits };
  })
);
