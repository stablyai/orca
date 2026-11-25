import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'
import { admitAutomationDetailSnapshot } from './automation-detail-retention'
import {
  DEFINITION_LOADING,
  RUNS_LOADING,
  type AutomationDetailsContinuity,
  type AutomationDetailsDeps,
  type AutomationDetailsSnapshot
} from './automation-details-model'

export abstract class AutomationDetailsSelection {
  protected snapshot: AutomationDetailsSnapshot
  private readonly listeners = new Set<() => void>()
  protected readonly retentionKey = Symbol('automation-detail')
  protected disposed = false
  /** Bumped when a definition mutation starts and when it settles; a read from another epoch is dropped. */
  protected epoch = 0
  protected ownerEpoch = 0
  protected runsEpoch = 0
  protected readonly acknowledgedRunIds = new Set<string>()
  protected selectedRead = 0
  private selectedNeedsDefinition = false

  constructor(
    owner: AutomationOwnerRef,
    readonly automationId: string,
    protected readonly recentLimit: number,
    protected readonly deps: AutomationDetailsDeps,
    runId: string | null
  ) {
    this.snapshot = {
      owner,
      continuity: 'same',
      definition: DEFINITION_LOADING,
      runs: RUNS_LOADING,
      selected: runId ? { runId, status: 'loading', run: null } : null,
      mutating: false
    }
  }

  getSnapshot = (): AutomationDetailsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected update(patch: Partial<AutomationDetailsSnapshot>): void {
    if (this.disposed) {
      return
    }
    this.snapshot = admitAutomationDetailSnapshot(this.retentionKey, this.snapshot, {
      ...this.snapshot,
      ...patch
    })
    this.listeners.forEach((listener) => listener())
  }

  abstract recheckOwner(): AutomationDetailsContinuity
  protected abstract readDefinition(): void

  /** Pins another run; null unpins. */
  selectRun(runId: string | null): void {
    if (this.snapshot.selected?.runId === runId) {
      return
    }
    this.selectedRead += 1
    this.selectedNeedsDefinition = false
    this.update({ selected: runId ? { runId, status: 'loading', run: null } : null })
    if (runId && this.snapshot.runs.status !== 'loading') {
      this.settleSelectedFromRuns()
    }
  }

  retrySelected(): void {
    const selected = this.snapshot.selected
    if (selected && this.recheckOwner() === 'same') {
      this.update({ selected: { ...selected, status: 'loading', run: null } })
      this.readSelected()
    }
  }

  protected settleSelectedFromRuns(): void {
    const selected = this.snapshot.selected
    if (!selected) {
      return
    }
    const inWindow = this.snapshot.runs.value.find((run) => run.id === selected.runId)
    if (inWindow) {
      this.selectedRead += 1
      this.update({ selected: { runId: selected.runId, status: 'in-window', run: inWindow } })
    } else if (selected.status === 'loading' || selected.status === 'in-window') {
      this.readSelected()
    }
  }

  protected readSelected(): void {
    const selected = this.snapshot.selected
    if (!selected) {
      return
    }
    this.selectedNeedsDefinition = false
    this.update({ selected: { ...selected, status: 'loading', run: null } })
    const read = ++this.selectedRead
    void this.deps.readRun(this.snapshot.owner, this.automationId, selected.runId).then(
      (result) => this.settleSelected(read, selected.runId, result),
      (error: unknown) => this.settleSelected(read, selected.runId, { kind: 'error', error })
    )
  }

  private settleSelected(read: number, runId: string, result: AutomationRunRead): void {
    if (
      read !== this.selectedRead ||
      this.snapshot.selected?.runId !== runId ||
      this.recheckOwner() !== 'same'
    ) {
      return
    }
    switch (result.kind) {
      case 'run':
        this.update({ selected: { runId, status: 'ready', run: result.run } })
        return
      case 'run-missing':
      case 'unsupported':
        this.update({ selected: { runId, status: result.kind, run: null } })
        return
      case 'error':
        this.update({ selected: { runId, status: 'error', run: null } })
        return
      case 'definition-missing':
        // Stays loading until one definition read decides: gone, or a run read that failed.
        this.selectedNeedsDefinition = true
        this.readDefinition()
    }
  }

  protected settleSelectedAfterDefinition(): void {
    const selected = this.snapshot.selected
    if (!this.selectedNeedsDefinition || selected?.status !== 'loading') {
      return
    }
    this.selectedNeedsDefinition = false
    if (this.snapshot.definition.status === 'deleted') {
      return
    }
    // The definition is there (or unreadable), so the run read's "automation not found" was wrong.
    if (!this.snapshot.runs.value.some((run) => run.id === selected.runId)) {
      this.selectedRead += 1
      this.update({ selected: { ...selected, status: 'error', run: null } })
    }
  }
}
