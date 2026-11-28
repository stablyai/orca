import { isFinalAutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import { releaseAutomationPayload } from './automation-detail-retention'
import { AutomationDetailsSelection } from './automation-details-selection'
import {
  AUTOMATION_DETAILS_MAX_RUNS,
  AUTOMATION_DETAILS_MORE_RUNS,
  automationReadProblem,
  DEFINITION_LOADING,
  reconcileAutomationRuns,
  newestFirst,
  RUNS_LOADING,
  type AutomationRunsSlice
} from './automation-details-model'

export type SliceRead = { inFlight: boolean; queued: boolean }

export abstract class AutomationDetailsRuns extends AutomationDetailsSelection {
  private moreRead = 0
  private moreFlight = false
  private publication = 0
  private readonly exactPublications = new Map<string, number>()
  private readonly runWaiters = new Set<(runs: AutomationRun[]) => void>()
  private readonly runsRead: SliceRead = { inFlight: false, queued: false }

  protected publishRuns(runs: AutomationRunsSlice, source: 'newest' | 'older'): boolean {
    return this.update(
      {
        runs: {
          ...runs,
          capacityError: runs.capacityError?.source === source ? null : runs.capacityError
        }
      },
      source
    )
  }

  private preserveExact(runs: AutomationRun[], started: number): AutomationRun[] {
    return runs.map((run) => {
      if ((this.exactPublications.get(run.id) ?? 0) <= started) {
        return run
      }
      return (
        this.snapshot.runs.value.find((current) => current.id === run.id) ??
        (this.snapshot.selected?.runId === run.id ? this.snapshot.selected.run : null) ??
        run
      )
    })
  }

  protected readRuns(): void {
    if (this.runsRead.inFlight) {
      this.runsRead.queued = true
      return
    }
    this.runsRead.inFlight = true
    this.exactVersion += 1
    const ownerEpoch = this.ownerEpoch
    const runsEpoch = this.runsEpoch
    const started = this.publication
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, { limit: this.recentLimit })
      .then(
        (page) => this.settleRuns(ownerEpoch, runsEpoch, started, { page }),
        (error: unknown) => this.settleRuns(ownerEpoch, runsEpoch, started, { error })
      )
  }

  private settleRuns(
    ownerEpoch: number,
    runsEpoch: number,
    started: number,
    result: { page: AutomationRunsPage } | { error: unknown }
  ): void {
    this.runsRead.inFlight = false
    if (this.disposed) {
      return
    }
    if (
      ownerEpoch === this.ownerEpoch &&
      runsEpoch === this.runsEpoch &&
      this.recheckOwner() === 'same'
    ) {
      const previous = this.snapshot.runs
      if ('page' in result) {
        const next = reconcileAutomationRuns(
          { ...result.page, runs: this.preserveExact(result.page.runs, started) },
          previous,
          this.recentLimit,
          previous.paged ?? false
        )
        const admitted = this.publishRuns(
          { ...next, capacityError: previous.capacityError },
          'newest'
        )
        if (admitted && this.snapshot.runs.nextCursor !== previous.nextCursor) {
          this.moreRead += 1
          this.moreFlight = false
        }
        if (admitted) {
          this.settleSelectedFromRuns()
        } else {
          this.readSelected()
        }
      } else {
        const hasValue = previous.value.length > 0
        this.update({
          runs: {
            ...previous,
            status: hasValue ? 'ready' : 'error',
            error: automationReadProblem(result.error),
            stale: hasValue
          }
        })
        this.readSelected()
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

  protected override acceptSelectedRun(run: AutomationRun): void {
    const prior = this.snapshot.selected?.run
    if (
      prior &&
      isFinalAutomationRunStatus(prior.status) &&
      !isFinalAutomationRunStatus(run.status)
    ) {
      return
    }
    const runs = this.snapshot.runs
    const admitted = this.update({
      selected: { runId: run.id, status: 'ready', run },
      runs: runs.value.some((row) => row.id === run.id)
        ? { ...runs, value: runs.value.map((row) => (row.id === run.id ? run : row)) }
        : runs
    })
    if (admitted) {
      this.exactPublications.set(run.id, ++this.publication)
      for (const id of this.exactPublications.keys()) {
        if (id !== run.id && !runs.value.some((row) => row.id === id)) {
          this.exactPublications.delete(id)
        }
      }
    }
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
    this.moreFlight = false
    this.exactPublications.clear()
    this.exactVersion += 1
    this.runWaiters.forEach((resolve) => resolve([]))
    this.runWaiters.clear()
    releaseAutomationPayload(this.retentionKey)
    this.snapshot = {
      ...this.snapshot,
      definition: DEFINITION_LOADING,
      runs: RUNS_LOADING,
      selected: null
    }
  }

  loadMore(): void {
    const runs = this.snapshot.runs
    if (this.moreFlight || !runs.nextCursor || runs.capped || this.recheckOwner() !== 'same') {
      return
    }
    this.moreFlight = true
    this.update({ runs: { ...runs, loadingMore: true } })
    const ownerEpoch = this.ownerEpoch
    const read = ++this.moreRead
    const cursor = runs.nextCursor
    const started = this.publication
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, {
        limit: AUTOMATION_DETAILS_MORE_RUNS,
        cursor
      })
      .then(
        (page) => {
          if (read === this.moreRead) {
            this.moreFlight = false
          }
          if (this.disposed || read !== this.moreRead || ownerEpoch !== this.ownerEpoch) {
            return
          }
          if (this.recheckOwner() !== 'same') {
            this.update({ runs: { ...this.snapshot.runs, loadingMore: false } })
            return
          }
          const current = this.snapshot.runs
          const value = newestFirst([
            ...new Map(
              [...current.value, ...this.preserveExact(page.runs, started)].map((run) => [
                run.id,
                run
              ])
            ).values()
          ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
          const admitted = this.publishRuns(
            {
              ...current,
              value,
              paged: true,
              coverageIds: [
                ...new Set([...(current.coverageIds ?? []), ...page.runs.map((run) => run.id)])
              ].filter((id) => value.some((run) => run.id === id)),
              olderError: null,
              nextCursor: page.nextCursor,
              loadingMore: false,
              capped: value.length >= AUTOMATION_DETAILS_MAX_RUNS
            },
            'older'
          )
          if (admitted) {
            this.settleSelectedFromRuns()
          }
        },
        (error: unknown) => {
          if (read === this.moreRead) {
            this.moreFlight = false
          }
          if (this.disposed || read !== this.moreRead || ownerEpoch !== this.ownerEpoch) {
            return
          }
          this.update({
            runs: {
              ...this.snapshot.runs,
              loadingMore: false,
              olderError: automationReadProblem(error)
            }
          })
        }
      )
  }
}
