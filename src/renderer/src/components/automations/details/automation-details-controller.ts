/**
 * One automation's definition, newest runs and one asked-for run, read through a captured owner.
 * Shared by every surface that shows a single automation outside the page's catalog (the chat card,
 * the bot panel), so its read rules hold everywhere:
 * - The definition and the runs are read independently: one failing keeps the other, and a failed
 *   re-read keeps the last good value, marked stale.
 * - A chat-card save invalidates older definition reads without changing its action transport.
 * - An asked-for run is read by id when it isn't among the newest rows, with typed outcomes; only a
 *   missing definition means the automation is gone.
 * - Every call is pinned to the captured pairing; a re-pair to another machine retires the data.
 */

import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'

import {
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
              : null
          })
        }
        return result.status
    }
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

  /** An existing chat-card save replaces its read without changing that action's transport. */
  replaceDefinition(automation: Automation): void {
    this.epoch += 1
    if (!this.disposed && this.recheckOwner() === 'same') {
      this.update({ definition: { status: 'ready', value: automation, error: null, stale: false } })
    }
  }
}
