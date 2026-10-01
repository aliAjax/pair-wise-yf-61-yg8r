import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, take } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import { LedgerPersistence } from './state/ledger.persistence';
import {
  selectAudits,
  selectBatches,
  selectBatchLedger,
  selectGroups,
  selectLastConflict,
  selectLedgerRevision,
  selectReadOnly,
  selectRelease,
  selectStorageStatus,
  statusLabel
} from './state/release.selectors';
import {
  approveBatch,
  bumpBatchVersion,
  clearConflict,
  createBatch,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  submitReceipts,
  telemetryTick
} from './state/release.actions';
import type { ReceiptConflict, ReceiptStage, ReleaseBatch } from './state/release.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, MatTooltipModule, MatSlideToggleModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA LEDGER</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set>
        <mat-chip highlighted>重复回执只记一次</mat-chip>
        <mat-chip>版本变更自动失效</mat-chip>
        <mat-chip [color]="storageStatus() === 'ok' ? 'primary' : 'warn'" highlighted>
          {{ storageStatus() === 'ok' ? '存储正常' : '存储降级' }}
        </mat-chip>
      </mat-chip-set>
    </header>

    <main>
      <mat-card appearance="outlined" class="banner" *ngIf="readOnly()">
        <mat-card-content>
          <b>历史只读账本</b>
          <span>检测到旧版本数据缺少账本版本号，已升级为历史只读：可查看批次与审计，不可提交回执或变更批次。</span>
        </mat-card-content>
      </mat-card>

      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name" [disabled]="readOnly()"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware" [disabled]="readOnly()"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion" [disabled]="readOnly()"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label>
              <mat-select [(ngModel)]="draft.groupId" [disabled]="readOnly()">
                <mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent" [disabled]="readOnly()"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold" [disabled]="readOnly()"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()" [disabled]="readOnly()">创建兼容批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="172" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row">
                  <div>
                    <b>{{ batch.name }}</b>
                    <small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }}</small>
                    <small class="occupy" *ngIf="occupantName(batch.groupId) && batch.status !== 'waiting'">
                      发布窗口占用中：{{ occupantName(batch.groupId) }}
                    </small>
                    <small class="waiting" *ngIf="batch.status === 'waiting'">
                      等候中 · 分组窗口被占用 · 第 {{ waitingRank(batch.id) }} 位
                    </small>
                  </div>
                  <mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' || batch.status === 'waiting' ? 'warn' : 'primary'" highlighted>
                    {{ statusLabel(batch.status) }}
                  </mat-chip>
                </div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已下载 · 安装 {{ batch.installed }} · 重启 {{ batch.rebooted }} · 失败 {{ batch.failed }}</span><span>{{ batch.progress }}%</span></div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)" [disabled]="readOnly()">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)" [disabled]="readOnly()">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)" [disabled]="readOnly()">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)" [disabled]="readOnly()">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back' || readOnly()" (click)="rollback(batch.id)">紧急回滚</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running' || batch.status === 'paused'" (click)="selectBatch(batch.id)" [disabled]="readOnly()">打开账本</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined" class="ledger-panel">
        <mat-card-header>
          <mat-card-title>发布账本 · 按设备号记录下载 / 安装 / 重启</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <div class="ledger-toolbar">
            <mat-form-field class="batch-select">
              <mat-label>选择批次</mat-label>
              <mat-select [ngModel]="selectedBatchId()" (ngModelChange)="selectBatch($event)">
                <mat-option *ngFor="let batch of batches$ | async" [value]="batch.id">{{ batch.name }} · {{ batch.firmware }}</mat-option>
              </mat-select>
            </mat-form-field>
            <span class="rev" *ngIf="ledger()">
              清单版本 #{{ listBaseRevision() }} / 账本当前 #{{ ledgerRevision() }}
              <b class="stale" *ngIf="listBaseRevision() !== ledgerRevision()">（清单已过期，提交将冲突）</b>
            </span>
            <span class="spacer"></span>
            <mat-form-field class="bump-input">
              <mat-label>新版本号</mat-label>
              <input matInput [ngModel]="bumpDraft()" (ngModelChange)="bumpDraft.set($event)" placeholder="如 3.0.1">
            </mat-form-field>
            <button mat-stroked-button (click)="bumpVersion()" [disabled]="readOnly() || !selectedBatchId()">版本变更</button>
          </div>

          <ng-container *ngIf="ledger(); else noLedger">
            <div class="ledger-summary">
              <mat-chip-set>
                <mat-chip>目标 {{ ledger()!.target }}</mat-chip>
                <mat-chip>已下载 {{ ledger()!.downloaded }}</mat-chip>
                <mat-chip>已安装 {{ ledger()!.installed }}</mat-chip>
                <mat-chip>已重启 {{ ledger()!.rebooted }}</mat-chip>
              </mat-chip-set>
            </div>
            <div class="device-grid">
              <span class="device" *ngFor="let d of ledger()!.devices" [class]="d.stage" [matTooltip]="d.deviceId">
                <i></i>{{ d.deviceId }}
              </span>
            </div>
            <div class="ledger-actions">
              <button mat-flat-button color="primary" (click)="submit('值班员 A')" [disabled]="readOnly() || !hasPending()">提交回执（值班员 A）</button>
              <button mat-flat-button color="accent" (click)="submit('值班员 B')" [disabled]="readOnly() || !hasPending()">提交回执（值班员 B）</button>
              <button mat-stroked-button (click)="refreshList()">刷新清单</button>
              <span class="hint">两名值班员使用同一清单版本提交，后到者将看到冲突设备与最新批次</span>
            </div>
          </ng-container>
          <ng-template #noLedger><p class="empty">选择一个批次查看设备账本</p></ng-template>

          <mat-card appearance="outlined" class="conflict" *ngIf="pendingConflict()">
            <mat-card-content>
              <b>回执冲突 · {{ pendingConflict()!.actor }}</b>
              <p>账本已更新至 <b>#{{ pendingConflict()!.serverRevision }}</b>，你的清单版本 <b>#{{ pendingConflict()!.baseRevision }}</b> 已过期。</p>
              <p>冲突设备（先到回执已占用）：
                <mat-chip-set>
                  <mat-chip *ngFor="let d of pendingConflict()!.conflictingDevices" color="warn" highlighted>{{ d }}</mat-chip>
                </mat-chip-set>
              </p>
              <p>最新批次：<b>{{ pendingConflict()!.latestBatch.name }}</b> · {{ pendingConflict()!.latestBatch.firmware }} · {{ statusLabel(pendingConflict()!.latestBatch.status) }} · 已下载 {{ pendingConflict()!.latestBatch.downloaded }}</p>
              <div class="actions">
                <button mat-flat-button color="primary" (click)="retryConflict()">按最新批次重试未完成部分</button>
                <button mat-stroked-button (click)="pendingConflict.set(null)">取消</button>
              </div>
            </mat-card-content>
          </mat-card>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined" class="storage-panel">
        <mat-card-header><mat-card-title>存储与恢复</mat-card-title></mat-card-header>
        <mat-card-content class="storage-row">
          <mat-chip-set>
            <mat-chip [color]="storageStatus() === 'ok' ? 'primary' : 'warn'" highlighted>
              {{ storageStatus() === 'ok' ? '存储正常' : '存储降级' }}
            </mat-chip>
            <mat-chip *ngIf="persistence.pendingCount() > 0" color="warn" highlighted>待重试回执 {{ persistence.pendingCount() }}</mat-chip>
          </mat-chip-set>
          <span class="spacer"></span>
          <mat-slide-toggle [checked]="faultOn()" (change)="toggleFault($event.checked)" [disabled]="readOnly()">模拟存储故障</mat-slide-toggle>
          <button mat-stroked-button (click)="retryStorage()" [disabled]="persistence.pendingCount() === 0">重试未完成部分</button>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .banner { background:#fff8e1; } .banner mat-card-content { display:flex; gap:12px; align-items:baseline; } .banner b { color:#8a6d00; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:540px; } .batch { min-height:172px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c }
    .occupy { color:#0f6f6c; font-weight:600; } .waiting { color:#b26a00; font-weight:600; }
    .actions { display:flex;gap:8px;flex-wrap:wrap }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    .ledger-toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
    .batch-select { min-width:260px; } .bump-input { width:160px; } .spacer { flex:1; }
    .rev { color:#607d86; font-size:13px; } .rev .stale { color:#c62828; }
    .ledger-summary { margin-bottom:12px; }
    .device-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:6px; max-height:260px; overflow:auto; padding:4px; border:1px solid #e5ecee; border-radius:6px; }
    .device { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:4px; font-size:12px; background:#eceff1; color:#546e7a; }
    .device i { width:8px; height:8px; border-radius:50%; background:#b0bec5; }
    .device.downloaded { background:#e0f2f1; color:#00695c; } .device.downloaded i { background:#26a69a; }
    .device.installed { background:#e3f2fd; color:#1565c0; } .device.installed i { background:#1976d2; }
    .device.rebooted { background:#e8f5e9; color:#2e7d32; } .device.rebooted i { background:#43a047; }
    .ledger-actions { display:flex; gap:10px; align-items:center; margin-top:14px; flex-wrap:wrap; }
    .ledger-actions .hint { color:#71858c; font-size:12px; }
    .conflict { margin-top:16px; background:#fff3e0; border-left:4px solid #ef6c00; } .conflict p { margin:6px 0; }
    .storage-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .empty { color:#90a4ae; padding:24px; text-align:center; }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly persistence = inject(LedgerPersistence);
  private readonly destroyRef = inject(DestroyRef);

  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);

  readonly state = toSignal(this.store.select(selectRelease), { initialValue: null });
  readonly storageStatus = toSignal(this.store.select(selectStorageStatus), { initialValue: 'ok' as const });
  readonly readOnly = toSignal(this.store.select(selectReadOnly), { initialValue: false });
  readonly ledgerRevision = toSignal(this.store.select(selectLedgerRevision), { initialValue: 0 });

  readonly selectedBatchId = signal<string | null>(null);
  readonly listBaseRevision = signal(0);
  readonly pendingConflict = signal<ReceiptConflict | null>(null);
  readonly bumpDraft = signal('');
  readonly faultOn = signal(false);

  readonly ledger = computed(() => {
    const s = this.state();
    const id = this.selectedBatchId();
    if (!s || !id) return null;
    return selectBatchLedger(id)(s);
  });

  private timer?: number;
  private metaTimer?: number;
  private readonly persistedReceiptIds = new Set<string>();
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.setupPersistence();
  }

  ngOnDestroy() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.metaTimer) window.clearTimeout(this.metaTimer);
  }

  private setupPersistence() {
    this.store.select(selectRelease)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (!state) return;
        // 首次加载：账本回执已从本地恢复，不重复落盘
        if (this.persistedReceiptIds.size === 0 && state.receipts.length >= 0 && !this.persistenceInitialized) {
          state.receipts.forEach((r) => this.persistedReceiptIds.add(r.id));
          this.persistenceInitialized = true;
          return;
        }
        for (const r of state.receipts) {
          if (!this.persistedReceiptIds.has(r.id)) {
            this.persistedReceiptIds.add(r.id);
            this.persistence.persistReceipt(r);
          }
        }
        if (this.metaTimer) window.clearTimeout(this.metaTimer);
        this.metaTimer = window.setTimeout(() => this.persistence.persistMeta(state), 400);
      });
  }
  private persistenceInitialized = false;

  pausedCount() {
    let count = 0;
    this.batches$.subscribe((items) => count = items.filter((item) => item.status === 'paused').length).unsubscribe();
    return count;
  }

  occupantName(groupId: string): string {
    const s = this.state();
    if (!s) return '';
    const occupant = s.batches.find((b) => b.groupId === groupId && (b.status === 'running' || b.status === 'paused'));
    return occupant ? occupant.name : '';
  }

  waitingRank(batchId: string): number {
    const s = this.state();
    const batch = s?.batches.find((b) => b.id === batchId);
    if (!s || !batch || batch.status !== 'waiting') return 0;
    const sameGroup = s.batches
      .filter((b) => b.groupId === batch.groupId && b.status === 'waiting')
      .sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt));
    return sameGroup.findIndex((b) => b.id === batchId) + 1;
  }

  hasPending(): boolean {
    const l = this.ledger();
    return !!l && l.devices.some((d) => d.level < 1);
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = {
      ...this.draft,
      id: crypto.randomUUID(),
      status: 'draft',
      progress: 0,
      downloaded: 0,
      installed: 0,
      rebooted: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionHistory: []
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }

  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }

  selectBatch(id: string) {
    this.selectedBatchId.set(id);
    this.refreshList();
  }

  refreshList() {
    this.store.select(selectLedgerRevision).pipe(take(1)).subscribe((rev) => this.listBaseRevision.set(rev));
  }

  /** 两名值班员使用同一清单版本提交；后到者通过乐观并发看到冲突设备与最新批次 */
  submit(actor: string) {
    const s = this.state();
    const id = this.selectedBatchId();
    if (!s || !id || s.readOnly) return;
    const batch = s.batches.find((b) => b.id === id);
    const l = this.ledger();
    if (!batch || !l) return;
    const receipts = l.devices
      .filter((d) => d.level < 1)
      .slice(0, 5)
      .map((d) => ({ deviceId: d.deviceId, stage: 'downloaded' as ReceiptStage, version: batch.firmware }));
    if (receipts.length === 0) return;
    const clientId = crypto.randomUUID();
    this.store.dispatch(submitReceipts({ batchId: id, receipts, baseRevision: this.listBaseRevision(), actor, clientId }));
    this.refreshList();
    this.store.select(selectLastConflict).pipe(take(1), filter((c) => c?.clientId === clientId)).subscribe((c) => {
      if (c) this.pendingConflict.set(c);
    });
  }

  retryConflict() {
    const conflict = this.pendingConflict();
    const s = this.state();
    if (!conflict || !s) return;
    const batch = s.batches.find((b) => b.id === conflict.batchId);
    const l = this.ledger();
    if (!batch || !l) return;
    const receipts = l.devices
      .filter((d) => d.level < 1)
      .slice(0, 5)
      .map((d) => ({ deviceId: d.deviceId, stage: 'downloaded' as ReceiptStage, version: batch.firmware }));
    const clientId = crypto.randomUUID();
    this.store.dispatch(clearConflict({ clientId: conflict.clientId }));
    this.store.dispatch(submitReceipts({ batchId: conflict.batchId, receipts, baseRevision: s.ledgerRevision, actor: conflict.actor, clientId }));
    this.pendingConflict.set(null);
    this.refreshList();
    this.store.select(selectLastConflict).pipe(take(1), filter((c) => c?.clientId === clientId)).subscribe((c) => {
      if (c) this.pendingConflict.set(c);
    });
  }

  bumpVersion() {
    const s = this.state();
    const id = this.selectedBatchId();
    const next = this.bumpDraft().trim();
    if (!s || !id || !next) return;
    const batch = s.batches.find((b) => b.id === id);
    if (!batch || batch.firmware === next) return;
    this.store.dispatch(bumpBatchVersion({ id, firmware: next, actor: '发布负责人', reason: '批次版本变更' }));
    this.bumpDraft.set('');
    this.refreshList();
  }

  toggleFault(on: boolean) {
    this.faultOn.set(on);
    this.persistence.setFault(on);
    if (!on) this.persistence.retryPending();
  }

  retryStorage() {
    this.persistence.retryPending();
  }

  statusLabel(status: ReleaseBatch['status']): string {
    return statusLabel(status);
  }
}
