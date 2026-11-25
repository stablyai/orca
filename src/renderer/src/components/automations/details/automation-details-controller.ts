/**
 * One automation's definition, newest runs and one asked-for run, read through a captured owner.
 * Shared by every surface that shows a single automation outside the page's catalog (the chat card,
 * the bot panel), so its read rules hold everywhere:
 * - The definition and the runs are read independently: one failing keeps the other, and a failed
 *   re-read keeps the last good value, marked stale.
 * - A definition mutation fences reads: nothing read before it settled is shown after it. Clocks are
 *   never compared; an epoch counts mutations.
 * - An asked-for run is read by id when it isn't among the newest rows, with typed outcomes; only a
 *   missing definition means the automation is gone.
 * - Every call is pinned to the captured pairing; a re-pair to another machine retires the data.
 */

import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'

import {
  newestFirst,
  AUTOMATION_DETAILS_MAX_RUNS,
  AutomationMutationBusyError,
  AutomationOwnerChangedError,
  automationReadProblem,
  isAutomationNotFound,
  DEFINITION_LOADING,
  RUNS_LOADING,
  type AutomationDetailsContinuity,
  type AutomationDetailsDeps
} from './automation-details-model'

import { AutomationDetailsRuns, type SliceRead } from './automation-details-runs'

export class AutomationDetailsController extends AutomationDetailsRuns {
  private readonly definitionRead: SliceRead = { inFlight: false, queued: false }

  constructor(
    owner: AutomationOwnerRef,
    automationId: string,
    recentLimit: number,
    deps: AutomationDetailsDeps,
    runId: string | null = null
  ) {
    super(owner, automationId, recentLimit, deps, runId)
  }

  start(): void {
    // A remount (StrictMode replays effects) starts the same controller again.
    this.disposed = false
    if (this.recheckOwner() === 'same') {
      this.readDefinition()
      this.readRuns()
    }
  }

  /** Late answers after this are dropped. */
  dispose(): void {
    this.disposed = true
    this.epoch += 1
    this.ownerEpoch += 1
    this.runsEpoch += 1
    this.selectedRead += 1
    this.releaseRuns()
  }

  /** Re-reads both parts; reads already in flight queue one more rather than stacking. */
  reload(): void {
    if (this.recheckOwner() !== 'same') {
      return
    }
    this.readDefinition()
    this.readRuns()
  }

  /**
   * Re-checks the captured owner. A same-machine re-pair re-keys it and keeps the data; a re-pair
   * still proving its host freezes actions; another machine, or no pairing, drops what was read.
   */
  override recheckOwner(): AutomationDetailsContinuity {
    const result = this.deps.evaluateOwner(this.snapshot.owner)
    switch (result.status) {
      case 'same':
      case 'continued':
        if (result.owner !== this.snapshot.owner || this.snapshot.continuity !== 'same') {
          this.update({ owner: result.owner, continuity: 'same' })
        }
        return 'same'
      case 'checking':
        if (this.snapshot.continuity !== 'checking') {
          this.update({ continuity: 'checking' })
        }
        return 'checking'
      case 'retired':
      case 'unpaired':
        if (this.snapshot.continuity !== result.status) {
          // Nothing read from the old machine may be acted on, and its late answers are dropped.
          this.epoch += 1
          this.ownerEpoch += 1
          this.selectedRead += 1
          this.update({
            continuity: result.status,
            definition: { ...DEFINITION_LOADING, status: 'error' },
            runs: { ...RUNS_LOADING, status: 'error' },
            selected: this.snapshot.selected
              ? { ...this.snapshot.selected, status: 'error', run: null }
              : null,
            acknowledgedRun: null
          })
        }
        return result.status
    }
  }

  private assertActionable(): AutomationOwnerRef {
    const continuity = this.recheckOwner()
    if (continuity !== 'same') {
      throw new AutomationOwnerChangedError(continuity)
    }
    return this.snapshot.owner
  }

  protected override readDefinition(): void {
    if (this.definitionRead.inFlight) {
      this.definitionRead.queued = true
      return
    }
    this.definitionRead.inFlight = true
    const epoch = this.epoch
    const owner = this.snapshot.owner
    void this.deps.showAutomation(owner, this.automationId).then(
      (automation) => this.settleDefinition(epoch, { automation }),
      (error: unknown) => this.settleDefinition(epoch, { error })
    )
  }

  private settleDefinition(
    epoch: number,
    result: { automation: Automation } | { error: unknown }
  ): void {
    this.definitionRead.inFlight = false
    if (this.disposed) {
      return
    }
    if (epoch === this.epoch && this.recheckOwner() === 'same') {
      if ('automation' in result) {
        this.update({
          definition: { status: 'ready', value: result.automation, error: null, stale: false }
        })
      } else if (isAutomationNotFound(result.error)) {
        this.update({ definition: { status: 'deleted', value: null, error: null, stale: false } })
      } else {
        const previous = this.snapshot.definition.value
        this.update({
          definition: {
            status: previous ? 'ready' : 'error',
            value: previous,
            error: automationReadProblem(result.error),
            stale: previous !== null
          }
        })
      }
      this.settleSelectedAfterDefinition()
    }
    if (this.definitionRead.queued) {
      this.definitionRead.queued = false
      if (this.recheckOwner() === 'same') {
        this.readDefinition()
      }
    }
  }

  /**
   * Runs one definition change (switch, save, delete) through the captured owner. Only one at a
   * time. Reads that started before it settled are dropped; one re-read follows it.
   * `apply` maps the result to the new definition, or 'deleted'.
   */
  async mutate<T>(
    change: (owner: AutomationOwnerRef) => Promise<T>,
    apply: (result: T) => Automation | 'deleted' | null
  ): Promise<T> {
    if (this.snapshot.mutating) {
      throw new AutomationMutationBusyError()
    }
    const owner = this.assertActionable()
    const ownerEpoch = this.ownerEpoch
    this.epoch += 1
    this.update({ mutating: true })
    try {
      const result = await change(owner)
      const continuity = this.recheckOwner()
      if (continuity !== 'same') {
        throw new AutomationOwnerChangedError(continuity)
      }
      if (ownerEpoch !== this.ownerEpoch || this.disposed) {
        return result
      }
      this.epoch += 1
      const next = apply(result)
      if (next === 'deleted') {
        this.update({ definition: { status: 'deleted', value: null, error: null, stale: false } })
      } else if (next) {
        this.update({ definition: { status: 'ready', value: next, error: null, stale: false } })
      }
      return result
    } finally {
      this.epoch += 1
      this.snapshot = { ...this.snapshot, mutating: false }
      this.update({ mutating: false })
      if (
        this.snapshot.definition.status !== 'deleted' &&
        !this.disposed &&
        this.recheckOwner() === 'same'
      ) {
        this.readDefinition()
      }
    }
  }

  async startRun(
    action: (owner: AutomationOwnerRef) => Promise<AutomationRun>
  ): Promise<AutomationRun> {
    const owner = this.assertActionable()
    const ownerEpoch = this.ownerEpoch
    try {
      const run = await action(owner)
      if (!this.disposed && this.recheckOwner() === 'same' && ownerEpoch === this.ownerEpoch) {
        this.runsEpoch += 1
        this.acknowledgeRun(run)
      }
      return run
    } finally {
      if (!this.disposed && this.recheckOwner() === 'same') {
        this.readRuns()
      }
    }
  }

  acknowledgeRun(run: AutomationRun): void {
    if (this.disposed || this.recheckOwner() !== 'same') {
      return
    }
    this.update({
      acknowledgedRun: {
        id: run.id,
        status: run.status,
        title: run.title.slice(0, 256),
        createdAt: run.createdAt,
        scheduledFor: run.scheduledFor
      }
    })
    this.publishRuns(
      {
        ...this.snapshot.runs,
        status: 'ready',
        value: newestFirst([
          run,
          ...this.snapshot.runs.value.filter((previous) => previous.id !== run.id)
        ]).slice(0, AUTOMATION_DETAILS_MAX_RUNS)
      },
      [run]
    )
  }

  /** An action that isn't a definition change (Run now); afterwards the runs are re-read. */
  async act<T>(action: (owner: AutomationOwnerRef) => Promise<T>): Promise<T> {
    const owner = this.assertActionable()
    try {
      return await action(owner)
    } finally {
      if (!this.disposed && this.recheckOwner() === 'same') {
        this.readRuns()
      }
    }
  }
}
