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
  RUNS_LOADING,
  type AutomationRunsSlice
} from './automation-details-model'

export type SliceRead = { inFlight: boolean; queued: boolean }

export abstract class AutomationDetailsRuns extends AutomationDetailsSelection {
  private moreRead = 0
  private moreFlight = false
  private acknowledgedRead = 0
  private readonly runWaiters = new Set<(runs: AutomationRun[]) => void>()
  private readonly runsRead: SliceRead = { inFlight: false, queued: false }

  protected publishRuns(runs: AutomationRunsSlice, authoritative: AutomationRun[]): boolean {
    const ack = this.snapshot.acknowledgedRun
    const seen = ack && authoritative.find((run) => run.id === ack.id)
    const retained = seen ?? (ack && this.snapshot.runs.value.find((run) => run.id === ack.id))
    let value = runs.value
    if (retained) {
      value = newestFirst([...value.filter((run) => run.id !== retained.id), retained])
      if (value.length > AUTOMATION_DETAILS_MAX_RUNS) {
        value = newestFirst([
          ...value
            .filter((run) => run.id !== retained.id)
            .slice(0, AUTOMATION_DETAILS_MAX_RUNS - 1),
          retained
        ])
      }
    }
    return this.update({
      runs: { ...runs, value, capacityError: null },
      acknowledgedRun: seen && isFinalAutomationRunStatus(seen.status) ? null : ack
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
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, { limit: this.recentLimit })
      .then(
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
    if (
      ownerEpoch === this.ownerEpoch &&
      runsEpoch === this.runsEpoch &&
      this.recheckOwner() === 'same'
    ) {
      const previous = this.snapshot.runs
      if ('page' in result) {
        const ack = this.snapshot.acknowledgedRun
        const next = reconcileAutomationRuns(
          result.page,
          previous,
          this.recentLimit,
          previous.paged ?? false,
          new Set(ack ? [ack.id] : [])
        )
        const admitted = this.publishRuns(next, result.page.runs)
        if (admitted && this.snapshot.runs.nextCursor !== previous.nextCursor) {
          this.moreRead += 1
        }
        if (
          this.snapshot.acknowledgedRun &&
          !result.page.runs.some((run) => run.id === this.snapshot.acknowledgedRun?.id)
        ) {
          this.readAcknowledged()
        }
        this.settleSelectedFromRuns()
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
        this.settleSelectedFromRuns()
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

  private readAcknowledged(): void {
    const ack = this.snapshot.acknowledgedRun
    if (!ack) {
      return
    }
    const ownerEpoch = this.ownerEpoch
    const read = ++this.acknowledgedRead
    void this.exactRuns.request(this.snapshot.owner, ack.id, this.exactVersion).then((result) => {
      if (
        this.disposed ||
        ownerEpoch !== this.ownerEpoch ||
        read !== this.acknowledgedRead ||
        this.recheckOwner() !== 'same' ||
        this.snapshot.acknowledgedRun?.id !== ack.id
      ) {
        return
      }
      if (result.kind === 'run') {
        const value = newestFirst([
          result.run,
          ...this.snapshot.runs.value.filter((run) => run.id !== ack.id)
        ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
        this.publishRuns({ ...this.snapshot.runs, value }, [result.run])
      }
    })
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
    this.acknowledgedRead += 1
    this.exactVersion += 1
    this.runWaiters.forEach((resolve) => resolve([]))
    this.runWaiters.clear()
    releaseAutomationPayload(this.retentionKey)
    this.snapshot = {
      ...this.snapshot,
      definition: DEFINITION_LOADING,
      runs: RUNS_LOADING,
      selected: null,
      acknowledgedRun: null
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
    void this.deps
      .listRunsPage(this.snapshot.owner, this.automationId, {
        limit: AUTOMATION_DETAILS_MORE_RUNS,
        cursor
      })
      .then(
        (page) => {
          this.moreFlight = false
          if (this.disposed || read !== this.moreRead || ownerEpoch !== this.ownerEpoch) {
            return
          }
          if (this.recheckOwner() !== 'same') {
            this.update({ runs: { ...this.snapshot.runs, loadingMore: false } })
            return
          }
          const current = this.snapshot.runs
          const value = newestFirst([
            ...new Map([...current.value, ...page.runs].map((run) => [run.id, run])).values()
          ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
          this.publishRuns(
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
            page.runs
          )
          this.settleSelectedFromRuns()
        },
        (error: unknown) => {
          this.moreFlight = false
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
