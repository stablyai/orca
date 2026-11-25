import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import { isFinalAutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import { releaseAutomationPayload } from './automation-detail-retention'
import { AutomationDetailsSelection } from './automation-details-selection'
import {
  AUTOMATION_DETAILS_MAX_RUNS,
  AUTOMATION_DETAILS_MORE_RUNS,
  automationReadProblem,
  DEFINITION_LOADING,
  reconcileAutomationRuns,
  newestFirst,
  RUNS_LOADING
} from './automation-details-model'

export type SliceRead = { inFlight: boolean; queued: boolean }

export abstract class AutomationDetailsRuns extends AutomationDetailsSelection {
  private moreRead = 0
  private paged = false
  private readonly runWaiters = new Set<(runs: AutomationRun[]) => void>()
  private readonly runsRead: SliceRead = { inFlight: false, queued: false }

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
        if (this.snapshot.runs.nextCursor !== previous.nextCursor) {
          this.moreRead += 1
        }
        this.reconcileAcknowledged(result.page.runs)
        const acknowledged = this.snapshot.acknowledgedRun
        if (acknowledged && !result.page.runs.some((run) => run.id === acknowledged.id)) {
          const readEpoch = this.runsEpoch
          void this.deps.readRun(this.snapshot.owner, this.automationId, acknowledged.id).then(
            (result) => {
              if (
                this.disposed ||
                ownerEpoch !== this.ownerEpoch ||
                readEpoch !== this.runsEpoch ||
                this.recheckOwner() !== 'same'
              ) {
                return
              }
              if (result.kind === 'run') {
                this.reconcileAcknowledged([result.run])
              } else if (result.kind === 'run-missing') {
                this.acknowledgedRunIds.delete(acknowledged.id)
                this.update({ acknowledgedRun: null })
              }
            },
            () => undefined
          )
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
    this.moreRead += 1
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
    const read = ++this.moreRead
    const cursor = runs.nextCursor
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, {
        limit: AUTOMATION_DETAILS_MORE_RUNS,
        cursor
      })
      .then(
        (page) => {
          if (this.disposed || read !== this.moreRead || ownerEpoch !== this.ownerEpoch) {
            return
          }
          if (this.recheckOwner() !== 'same') {
            this.update({ runs: { ...this.snapshot.runs, loadingMore: false } })
            return
          }
          const current = this.snapshot.runs
          this.paged = true
          const value = newestFirst([
            ...new Map([...current.value, ...page.runs].map((run) => [run.id, run])).values()
          ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
          this.update({
            runs: {
              ...current,
              value,
              error: null,
              nextCursor: page.nextCursor,
              loadingMore: false,
              capped: value.length >= AUTOMATION_DETAILS_MAX_RUNS
            }
          })
          this.reconcileAcknowledged(page.runs)
          this.settleSelectedFromRuns()
        },
        (error: unknown) => {
          if (this.disposed || read !== this.moreRead || ownerEpoch !== this.ownerEpoch) {
            return
          }
          if (this.recheckOwner() !== 'same') {
            this.update({ runs: { ...this.snapshot.runs, loadingMore: false } })
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

  private reconcileAcknowledged(runs: AutomationRun[]): void {
    const acknowledged = this.snapshot.acknowledgedRun
    const seen = acknowledged && runs.find((run) => run.id === acknowledged.id)
    if (seen && isFinalAutomationRunStatus(seen.status)) {
      this.acknowledgedRunIds.delete(seen.id)
      this.update({
        acknowledgedRun: null,
        runs: {
          ...this.snapshot.runs,
          value: this.snapshot.runs.value.map((run) => (run.id === seen.id ? seen : run))
        }
      })
    }
  }
}
