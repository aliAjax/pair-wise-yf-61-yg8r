import { Component, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  changeVersion,
  configureStorageFault,
  createBatch,
  dismissReceiptResult,
  pauseBatch,
  resumeBatch,
  retryPendingReceipts,
  rollbackBatch,
  startBatch,
  submitReceipts,
  telemetryTick
} from './state/release.actions';
import {
  selectAudits,
  selectBatchViews,
  selectGroupWindows,
  selectLastReceiptResult,
  selectLegacyCount,
  selectRunningCount,
  selectWaitingCount,
  type BatchView
} from './state/release.selectors';
import type { BatchStatus, DeviceStage, TelemetryReceipt } from './state/release.models';

const STATUS_LABEL: Record<BatchStatus, string> = {
  draft: '草稿',
  approved: '已审批',
  running: '发布中',
  waiting: '等候窗口',
  paused: '已暂停',
  completed: '已完成',
  rolled_back: '已回滚',
  legacy_readonly: '历史只读'
};

const STAGE_LABEL: Record<DeviceStage, string> = {
  downloaded: '下载',
  installed: '安装',
  rebooted: '重启'
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ScrollingModule, MatSlideToggleModule,
    MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule,
    MatInputModule, MatProgressBarModule, MatSelectModule, MatSlideToggleModule
  ],
  template: `
    <header class="hero">
      <div>
        <span class="eyebrow">OTA RECOVERABLE LEDGER</span>
        <h1>可恢复的固件发布账</h1>
        <p>设备分组 × 发布批次 × 遥测回执：按设备记账、窗口排队、版本失效、冲突可见、断点重试</p>
      </div>
      <mat-chip-set>
        <mat-chip highlighted>每设备一条账</mat-chip>
        <mat-chip>回执去重</mat-chip>
        <mat-chip>历史旧账只读</mat-chip>
      </mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>发布中（占用窗口）</span><strong>{{ running$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>等候批次</span><strong>{{ waiting$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>历史只读</span><strong>{{ legacy$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="windows">
        <mat-card appearance="outlined" *ngFor="let window of windows$ | async">
          <div class="window-head">
            <div>
              <b>{{ window.group.name }}</b>
              <small>{{ window.group.region }} · {{ window.group.count }} 台 · 离线网闸 {{ window.group.offlineGateways }}</small>
            </div>
            <span class="badge" [class.busy]="!!window.occupant" [class.free]="!window.occupant">
              {{ window.occupant ? '窗口占用中' : '窗口空闲' }}
            </span>
          </div>
          <div class="window-body" *ngIf="window.occupant">
            <span class="occupy">占用：{{ window.occupant.name }}（{{ window.occupant.firmwareVersion }}）· {{ label(window.occupant.status) }}</span>
          </div>
          <div class="window-body" *ngIf="!window.occupant"><small>没有运行/暂停批次，下一个已审批批次可直接发布</small></div>
          <div class="queue" *ngIf="window.waiting.length">
            <span>等候队列：</span>
            <span class="queue-item" *ngFor="let item of window.waiting; let i = index">#{{ i + 1 }} {{ item.name }}（{{ item.firmwareVersion }}）</span>
          </div>
        </mat-card>
      </section>

      <section class="grid">
        <div class="side">
          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>新建发布批次</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
              <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmwareVersion"></mat-form-field>
              <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
              <mat-form-field>
                <mat-label>设备分组</mat-label>
                <mat-select [(ngModel)]="draft.groupId">
                  <mat-option *ngFor="let group of windows$ | async" [value]="group.group.id" [disabled]="!group.group.compatible">
                    {{ group.group.name }} · {{ group.group.region }}{{ group.group.compatible ? '' : '（不兼容）' }}
                  </mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
              <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
              <button mat-flat-button color="primary" (click)="create()">创建批次（占用中则自动等候）</button>
            </mat-card-content>
          </mat-card>

          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>值班员提交遥测回执</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-form-field>
                <mat-label>目标批次</mat-label>
                <mat-select [(ngModel)]="receiptForm.batchId" (ngModelChange)="onBatchPick($event)">
                  <mat-option *ngFor="let batch of batches$ | async" [value]="batch.id" [disabled]="batch.readonly">
                    {{ batch.name }} · rev {{ batch.revision }} · {{ label(batch.status) }}
                  </mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field><mat-label>设备序号（从 0 开始）</mat-label><input matInput type="number" [(ngModel)]="receiptForm.deviceIndex"></mat-form-field>
              <mat-form-field>
                <mat-label>阶段</mat-label>
                <mat-select [(ngModel)]="receiptForm.stage">
                  <mat-option value="downloaded">下载</mat-option>
                  <mat-option value="installed">安装</mat-option>
                  <mat-option value="rebooted">重启</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field><mat-label>回执版本</mat-label><input matInput [(ngModel)]="receiptForm.firmwareVersion"></mat-form-field>
              <mat-form-field><mat-label>值班员</mat-label><input matInput [(ngModel)]="receiptForm.actor"></mat-form-field>
              <mat-form-field><mat-label>携带修订号（另一名值班员先成功后，这里就过期了）</mat-label><input matInput type="number" [(ngModel)]="receiptForm.baseRevision"></mat-form-field>
              <mat-slide-toggle [(ngModel)]="receiptForm.duplicate">重发上一条相同回执号（演练去重）</mat-slide-toggle>
              <div class="actions">
                <button mat-flat-button color="primary" [disabled]="!canSubmit()" (click)="submit()">提交回执</button>
              </div>
              <small *ngIf="currentBatch() as batch">
                当前批次 rev {{ batch.revision }}；目标 {{ batch.counters.target }} 台，
                下载 {{ batch.counters.downloaded }} / 安装 {{ batch.counters.installed }} / 重启 {{ batch.counters.rebooted }}
              </small>
            </mat-card-content>
          </mat-card>

          <mat-card appearance="outlined">
            <mat-card-header><mat-card-title>存储故障演练（可恢复提交）</mat-card-title></mat-card-header>
            <mat-card-content class="form-grid">
              <mat-slide-toggle [(ngModel)]="faultAll" (ngModelChange)="toggleFault()">开启后：下一批回执全部落盘失败</mat-slide-toggle>
              <mat-form-field><mat-label>只让指定设备序号落盘失败（逗号分隔，留空=不启用）</mat-label>
                <input matInput [(ngModel)]="faultDevicesText" (ngModelChange)="toggleFault()">
              </mat-form-field>
              <button mat-stroked-button [disabled]="!hasPending()" (click)="retry()">只重试未完成设备（{{ pendingCount() }} 条待重试）</button>
              <small>已完成设备的账不会丢；故障关闭后重试即可补齐未完成部分。</small>
            </mat-card-content>
          </mat-card>
        </div>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>发布批次与设备账</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="228" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async" [class.readonly]="batch.readonly">
                <div class="row">
                  <div>
                    <b>{{ batch.name }}</b>
                    <small>{{ batch.firmwareVersion }} → 回滚 {{ batch.rollbackVersion || '—' }} · 分组 {{ batch.groupId }} · 灰度 {{ batch.rolloutPercent }}%</small>
                  </div>
                  <span class="status status-{{ batch.status }}">{{ label(batch.status) }}</span>
                </div>
                <mat-progress-bar mode="determinate" [value]="batch.counters.progress"></mat-progress-bar>
                <div class="row">
                  <span>
                    重启 {{ batch.counters.rebooted }}/{{ batch.counters.target }}（{{ batch.counters.progress }}%）
                    · 下载 {{ batch.counters.downloaded }} · 安装 {{ batch.counters.installed }} · 失败 {{ batch.failed }} · 阈值 {{ batch.failureThreshold }}%
                  </span>
                  <small>rev {{ batch.revision }}</small>
                </div>

                <div class="ledger" *ngIf="!batch.readonly">
                  <span class="ledger-title">当前版本设备账（{{ batch.ledger.length }} 台，每台仅一条）：</span>
                  <span class="ledger-chip" *ngFor="let entry of batch.ledger.slice(0, 8)">
                    {{ shortDevice(entry.deviceId) }} · {{ stageLabel(entry.stage) }}
                  </span>
                  <span class="ledger-chip more" *ngIf="batch.ledger.length > 8">…其余 {{ batch.ledger.length - 8 }} 台</span>
                </div>
                <div class="ledger" *ngIf="batch.heldReceipts.length">
                  <span class="ledger-title warn-text">暂存回执 {{ batch.heldReceipts.length }} 条（暂停/回滚期间晚到，暂不计账）：</span>
                  <span class="ledger-chip warn" *ngFor="let held of batch.heldReceipts.slice(0, 6)">
                    {{ shortDevice(held.receipt.deviceId) }} · {{ stageLabel(held.receipt.stage) }}
                  </span>
                </div>
                <div class="ledger" *ngIf="batch.retainedResults.length">
                  <span class="ledger-title">版本变更后保留的已安装结果 {{ batch.retainedResults.length }} 台（历史，不计入当前进度）：</span>
                  <span class="ledger-chip retained" *ngFor="let retained of batch.retainedResults.slice(0, 6)">
                    {{ shortDevice(retained.deviceId) }} · {{ retained.firmwareVersion }} · {{ stageLabel(retained.stage) }}
                  </span>
                </div>
                <div class="ledger" *ngIf="batch.readonly">
                  <small>该批次由缺少版本字段的旧账升级而来，仅可查看，不能提交回执或变更版本。</small>
                </div>

                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="start(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'waiting'" (click)="start(batch.id)">请求发布（窗口占用则继续等候）</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续（重放暂存）</button>
                  <button mat-stroked-button *ngIf="!batch.readonly && batch.status !== 'completed' && batch.status !== 'rolled_back'" (click)="changeVer(batch.id, batch.firmwareVersion)">变更版本</button>
                  <button mat-flat-button color="warn" *ngIf="batch.status !== 'completed' && batch.status !== 'rolled_back' && !batch.readonly" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined" *ngIf="result$ | async as result" class="result-card">
        <mat-card-header>
          <mat-card-title>回执提交结果</mat-card-title>
          <span class="spacer"></span>
          <button mat-stroked-button (click)="dismiss()">关闭</button>
        </mat-card-header>
        <mat-card-content>
          <div *ngIf="result.rejectedReadonly" class="result-line error">历史只读批次拒绝提交。</div>
          <div *ngIf="result.notFound" class="result-line error">批次不存在。</div>
          <div *ngIf="result.conflicts.length" class="result-line error">
            <b>并发冲突：</b>你基于修订 {{ result.baseRevision }}，当前已为 {{ result.currentRevision }}。
            冲突设备：
            <span class="ledger-chip warn" *ngFor="let c of result.conflicts">
              {{ shortDevice(c.deviceId) }}：你提交{{ stageLabel(c.incomingStage) }}，当前为{{ c.currentStage ? stageLabel(c.currentStage) : '未开始' }}
            </span>
            <div>请以最新修订号 {{ result.currentRevision }} 重新拉取后再提交。
              <button mat-stroked-button (click)="syncRevision(result.currentRevision)">同步修订号到 {{ result.currentRevision }}</button>
            </div>
          </div>
          <div class="result-line" *ngIf="result.accepted.length">✅ 成功入账 {{ result.accepted.length }} 条，批次修订号推进至 {{ result.currentRevision }}。</div>
          <div class="result-line" *ngIf="result.duplicates.length">ℹ️ 重复回执 {{ result.duplicates.length }} 条，只出现一次，未改动账本。</div>
          <div class="result-line" *ngIf="result.staleVersion.length">⛔ 版本失效 {{ result.staleVersion.length }} 条（批次版本已变或设备不在当前目标内），立即作废。</div>
          <div class="result-line" *ngIf="result.held.length">⏳ 暂存 {{ result.held.length }} 条：批次不在发布中，未计入进度，恢复/接管窗口时重放。</div>
          <div class="result-line error" *ngIf="result.storageFailed.length">
            🔥 存储失败 {{ result.storageFailed.length }} 条，已完成设备保留。
            <button mat-stroked-button (click)="retry()">立即只重试未完成部分</button>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>审计记录</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list">
          <div class="audit" *ngFor="let item of audits$ | async">
            <span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p>
          </div>
        </mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(26px,3.4vw,44px); letter-spacing:-.03em; } .hero p { margin:0; opacity:.85 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .windows { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
    .window-head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px }
    .window-head small { display:block; color:#71858c; margin-top:2px }
    .window-body { margin-top:10px } .occupy { font-weight:600; color:#0f6f6c }
    .badge { font-size:12px; padding:3px 10px; border-radius:999px; white-space:nowrap }
    .badge.busy { background:#fdecea; color:#b3261e } .badge.free { background:#e6f4ea; color:#1e6b3a }
    .queue { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; font-size:13px; color:#5b6f76 }
    .queue-item { background:#eef3f4; border-radius:6px; padding:2px 8px }
    .grid { display:grid; grid-template-columns:minmax(320px,.9fr) minmax(460px,1.3fr); gap:20px; align-items:start; }
    .side { display:grid; gap:16px; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:16px }
    .form-grid mat-slide-toggle { grid-column:1/-1; margin:4px 0 }
    .viewport { height:600px; }
    .batch { min-height:204px; border-bottom:1px solid #dde7e8; padding:14px 4px; display:grid; gap:10px }
    .batch.readonly { opacity:.82; background:#f7f8f8; border-radius:8px; padding-left:10px }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center }
    small { color:#71858c }
    .status { font-size:12px; padding:3px 12px; border-radius:999px; font-weight:600; white-space:nowrap }
    .status-running { background:#e3f2fd; color:#1565c0 }
    .status-waiting { background:#fff4e0; color:#b26a00 }
    .status-paused { background:#fdecea; color:#b3261e }
    .status-approved { background:#e6f4ea; color:#1e6b3a }
    .status-completed { background:#e8f5e9; color:#2e7d32 }
    .status-rolled_back { background:#efebe9; color:#5d4037 }
    .status-draft { background:#eceff1; color:#455a64 }
    .status-legacy_readonly { background:#ede7f6; color:#5e35b1 }
    .ledger { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px }
    .ledger-title { color:#5b6f76; width:100% }
    .ledger-chip { background:#eef3f4; border-radius:6px; padding:2px 8px }
    .ledger-chip.more { color:#71858c }
    .ledger-chip.warn { background:#fdecea; color:#b3261e }
    .ledger-chip.retained { background:#ede7f6; color:#5e35b1 }
    .warn-text { color:#b3261e }
    .actions { display:flex;gap:8px;flex-wrap:wrap }
    .result-card { border-color:#b3261e22 }
    .result-line { margin:6px 0 } .result-line.error { color:#b3261e }
    .spacer { flex:1 }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:1000px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.windows{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly batches$ = this.store.select(selectBatchViews);
  private readonly batchesSignal = toSignal(this.batches$, { initialValue: [] as BatchView[] });
  readonly windows$ = this.store.select(selectGroupWindows);
  readonly audits$ = this.store.select(selectAudits);
  readonly running$ = this.store.select(selectRunningCount);
  readonly waiting$ = this.store.select(selectWaitingCount);
  readonly legacy$ = this.store.select(selectLegacyCount);
  readonly result$ = this.store.select(selectLastReceiptResult);
  private readonly resultSignal = toSignal(this.result$, { initialValue: null });
  readonly pendingCount = computed(() => this.resultSignal()?.storageFailed.length ?? 0);
  private timer?: number;
  private lastReceipt: TelemetryReceipt | null = null;

  draft = { name: '', firmwareVersion: '3.1.0', rollbackVersion: '3.0.0', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5 };
  receiptForm = {
    batchId: '',
    deviceIndex: 0,
    stage: 'downloaded' as DeviceStage,
    firmwareVersion: '',
    actor: '值班员A',
    baseRevision: 0,
    duplicate: false
  };
  faultAll = false;
  faultDevicesText = '';

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 2500);
    const first = this.batchesSignal().find((b) => !b.readonly);
    if (first) {
      this.receiptForm.batchId = first.id;
      this.receiptForm.firmwareVersion = first.firmwareVersion;
      this.receiptForm.baseRevision = first.revision;
    }
  }

  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  label(status: BatchStatus): string { return STATUS_LABEL[status]; }
  stageLabel(stage: DeviceStage): string { return STAGE_LABEL[stage]; }
  shortDevice(id: string): string { return id.slice(-9); }

  create() {
    if (!this.draft.name || !this.draft.firmwareVersion || !this.draft.groupId) return;
    this.store.dispatch(createBatch({ ...this.draft }));
    this.draft = { ...this.draft, name: '' };
  }

  onBatchPick(id: string) {
    const batch = this.batchById(id);
    if (batch) {
      this.receiptForm.firmwareVersion = batch.firmwareVersion;
      this.receiptForm.baseRevision = batch.revision;
    }
  }

  private batchById(id: string): BatchView | null {
    return this.batchesSignal().find((b) => b.id === id) ?? null;
  }

  currentBatch(): BatchView | null {
    return this.batchById(this.receiptForm.batchId);
  }

  canSubmit(): boolean {
    const batch = this.currentBatch();
    return !!batch && !batch.readonly && !!this.receiptForm.firmwareVersion;
  }

  private deviceId(batch: BatchView, index: number): string {
    return batch.deviceIds[index] ?? `${batch.groupId}-dev-${String(index + 1).padStart(4, '0')}`;
  }

  submit() {
    const batch = this.currentBatch();
    if (!batch) return;
    let receipt: TelemetryReceipt;
    if (this.receiptForm.duplicate && this.lastReceipt) {
      receipt = { ...this.lastReceipt };
    } else {
      receipt = {
        id: `manual-${crypto.randomUUID()}`,
        batchId: batch.id,
        deviceId: this.deviceId(batch, Number(this.receiptForm.deviceIndex) || 0),
        stage: this.receiptForm.stage,
        firmwareVersion: this.receiptForm.firmwareVersion,
        at: new Date().toISOString()
      };
      this.lastReceipt = receipt;
    }
    this.store.dispatch(submitReceipts({ batchId: batch.id, receipts: [receipt], baseRevision: Number(this.receiptForm.baseRevision) || 0, actor: this.receiptForm.actor || '值班员' }));
    // 成功（含暂存/部分失败）后同步为结果中的最新修订号；冲突时保留旧值，方便对照差异后手动同步。
    const result = this.resultSignal();
    if (result && result.conflicts.length === 0 && !result.rejectedReadonly && !result.notFound) {
      this.receiptForm.baseRevision = result.currentRevision;
    }
  }

  hasPending(): boolean { return this.pendingCount() > 0; }

  retry() {
    if (!this.lastReceipt) return;
    this.store.dispatch(retryPendingReceipts({ id: this.lastReceipt.batchId, actor: this.receiptForm.actor || '值班员' }));
  }

  dismiss() { this.store.dispatch(dismissReceiptResult()); }

  syncRevision(revision: number) { this.receiptForm.baseRevision = revision; }

  toggleFault() {
    const deviceIndexes = this.faultDevicesText.split(',').map((part) => part.trim()).filter(Boolean);
    if (!this.faultAll && deviceIndexes.length === 0) {
      this.store.dispatch(configureStorageFault({ fault: null }));
      return;
    }
    const batch = this.currentBatch();
    const deviceIds = batch ? deviceIndexes.map((raw) => this.deviceId(batch, Number(raw) || 0)) : [];
    this.store.dispatch(configureStorageFault({ fault: { failAll: this.faultAll, deviceIds } }));
  }

  start(id: string) { this.store.dispatch(startBatch({ id })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id })); }

  changeVer(id: string, current: string) {
    const next = window.prompt('输入新的固件版本号（未执行回执立即失效，已安装结果保留）：', bumpVersion(current));
    if (next && next !== current) this.store.dispatch(changeVersion({ id, firmwareVersion: next.trim() }));
  }
}

function bumpVersion(version: string): string {
  const parts = version.split('.');
  const last = Number(parts[parts.length - 1]);
  if (Number.isNaN(last)) return `${version}-next`;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}
