// The runs half of the shared automation details loader: the newest runs, older pages, and one
// asked-for run read by id. The definition half (and mutations) extends it.
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { isFinalAutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'
import {
  admitAutomationDetailSnapshot,
  releaseAutomationPayload
} from './automation-detail-retention'
import {
  AUTOMATION_DETAILS_MAX_RUNS,
  AUTOMATION_DETAILS_MORE_RUNS,
  automationReadProblem,
  DEFINITION_LOADING,
  reconcileAutomationRuns,
  RUNS_LOADING,
  type AutomationDetailsContinuity,
  type AutomationDetailsDeps,
  type AutomationDetailsSnapshot
} from './automation-details-model'

export type SliceRead = { inFlight: boolean; queued: boolean }

export abstract class AutomationDetailsRuns {
  protected snapshot: AutomationDetailsSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly retentionKey = Symbol('automation-detail')
  protected disposed = false
  /** Bumped when a definition mutation starts and when it settles; a read from another epoch is dropped. */
  protected epoch = 0
  protected ownerEpoch = 0
  protected runsEpoch = 0
  protected readonly acknowledgedRunIds = new Set<string>()
  private paged = false
  private readonly runWaiters = new Set<(runs: AutomationRun[]) => void>()
  private readonly runsRead: SliceRead = { inFlight: false, queued: false }
  protected selectedRead = 0
  private selectedNeedsDefinition = false

  constructor(
    owner: AutomationOwnerRef,
    readonly automationId: string,
    private readonly recentLimit: number,
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

  protected readRuns(): void {
    if (this.runsRead.inFlight) {
      this.runsRead.queued = true
      return
    }
    this.runsRead.inFlight = true
    const owner = this.snapshot.owner
    const ownerEpoch = this.ownerEpoch
    const runsEpoch = this.runsEpoch
    void this.deps.listRunsPage(owner, this.automationId, { limit: this.recentLimit }).then(
      (page) => this.settleRuns(ownerEpoch, runsEpoch, { page }),
      (error: unknown) => this.settleRuns(ownerEpoch, runsEpoch, { error })
    )
  }

  private settleRuns(
    ownerEpoch: number,
    runsEpoch: number,
    result: { page: AutomationRunsPage } | { error: unknown }
  ): void {
    this.runsRead.inFlight = false
    if (this.disposed) {
      return
    }
    // Definition mutations don't invalidate history, but a retired owner does.
    if (
      ownerEpoch === this.ownerEpoch &&
      runsEpoch === this.runsEpoch &&
      this.recheckOwner() === 'same'
    ) {
      const previous = this.snapshot.runs
      if ('page' in result) {
        this.update({
          runs: reconcileAutomationRuns(
            result.page,
            previous,
            this.recentLimit,
            this.paged,
            this.acknowledgedRunIds
          )
        })
        const acknowledged = this.snapshot.acknowledgedRun
        const seen = acknowledged && result.page.runs.find((run) => run.id === acknowledged.id)
        if (seen && isFinalAutomationRunStatus(seen.status)) {
          this.update({ acknowledgedRun: null })
        }
        this.settleSelectedFromRuns()
      } else {
        const hasValue = previous.status === 'ready'
        this.update({
          runs: {
            ...previous,
            status: hasValue ? 'ready' : 'error',
            error: automationReadProblem(result.error),
            stale: hasValue
          }
        })
        if (this.snapshot.selected?.status === 'loading') {
          this.readSelected()
        }
      }
    }
    if (this.runsRead.queued) {
      this.runsRead.queued = false
      if (this.recheckOwner() === 'same') {
        this.readRuns()
        return
      }
    }
    this.runWaiters.forEach((resolve) => resolve(this.snapshot.runs.value))
    this.runWaiters.clear()
  }

  refreshRuns(): Promise<AutomationRun[]> {
    if (this.disposed || this.recheckOwner() !== 'same') {
      return Promise.resolve(this.snapshot.runs.value)
    }
    return new Promise((resolve) => {
      this.runWaiters.add(resolve)
      this.readRuns()
    })
  }

  protected releaseRuns(): void {
    this.paged = false
    this.runWaiters.forEach((resolve) => resolve([]))
    this.runWaiters.clear()
    this.acknowledgedRunIds.clear()
    releaseAutomationPayload(this.retentionKey)
    this.snapshot = {
      ...this.snapshot,
      definition: DEFINITION_LOADING,
      runs: RUNS_LOADING,
      selected: null,
      acknowledgedRun: null
    }
  }

  /** The next older page, until the cap. */
  loadMore(): void {
    const runs = this.snapshot.runs
    if (runs.loadingMore || !runs.nextCursor || runs.capped || this.recheckOwner() !== 'same') {
      return
    }
    this.update({ runs: { ...runs, loadingMore: true } })
    const ownerEpoch = this.ownerEpoch
    const cursor = runs.nextCursor
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, {
        limit: AUTOMATION_DETAILS_MORE_RUNS,
        cursor
      })
      .then(
        (page) => {
          if (ownerEpoch !== this.ownerEpoch || this.recheckOwner() !== 'same') {
            return
          }
          const current = this.snapshot.runs
          this.paged = true
          const ids = new Set(current.value.map((run) => run.id))
          const value = [...current.value, ...page.runs.filter((run) => !ids.has(run.id))].slice(
            0,
            AUTOMATION_DETAILS_MAX_RUNS
          )
          this.update({
            runs: {
              ...current,
              value,
              nextCursor: page.nextCursor,
              loadingMore: false,
              capped: value.length >= AUTOMATION_DETAILS_MAX_RUNS
            }
          })
        },
        (error: unknown) => {
          if (ownerEpoch !== this.ownerEpoch || this.recheckOwner() !== 'same') {
            return
          }
          this.update({
            runs: {
              ...this.snapshot.runs,
              loadingMore: false,
              error: automationReadProblem(error)
            }
          })
        }
      )
  }

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

  private readSelected(): void {
    const selected = this.snapshot.selected
    if (!selected) {
      return
    }
    this.selectedNeedsDefinition = false
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
