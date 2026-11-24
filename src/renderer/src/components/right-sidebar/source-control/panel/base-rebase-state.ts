import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type {
  RebaseAutoStashSetting,
  RebaseStopInspectFailure,
  RebaseStopReading
} from './worktree-operation-store'
import {
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef
} from './branch-context-stats'

export type BaseRebaseState =
  | { kind: 'none' }
  | { kind: 'up_to_date' }
  | { kind: 'behind'; behind: number; baseLabel: string; blockedBy: 'dirty' | 'busy' | null }
  // continueState: unknown until the stop is read for this HEAD; blocked when Git cannot continue it;
  // unreadable when the read failed, so the strip can say why and retry.
  | {
      kind: 'rebase_paused'
      unresolvedCount: number
      continueState: RebaseContinueState
      inspectFailureMessage: string | null
    }

// An empty stop cannot be continued until its index changes.
export type RebaseContinueState = 'ready' | 'empty' | 'blocked' | 'unknown' | 'unreadable'

export type BaseRebaseInputs = {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  effectiveBaseRef: string | null
  conflictOperation: GitConflictOperation
  unresolvedConflictCount: number
  hasTrackedChanges: boolean
  rebaseAutoStash: RebaseAutoStashSetting
  rebaseStop: RebaseStopReading | null
  rebaseStopInspectFailure: RebaseStopInspectFailure | null
  indexObservation: string | null
  statusHead: string | null
  isBusy: boolean
}

/** Commits behind the rebase target, or null when the compare row measures another ref (e.g. upstream mode). */
export function resolveRebaseBehindCount(
  summary: GitBranchCompareSummary | null,
  compareBaseRef: string | null,
  effectiveBaseRef: string | null
): number | null {
  const displayedBaseRef = resolveSourceControlDisplayedBaseRef(summary, compareBaseRef)
  if (
    summary?.status !== 'ready' ||
    !displayedBaseRef ||
    !effectiveBaseRef ||
    formatSourceControlRefLabel(displayedBaseRef) !== formatSourceControlRefLabel(effectiveBaseRef)
  ) {
    return null
  }
  return summary.commitsBehind ?? null
}

// Git refuses to rebase over tracked edits; an unprobed config counts as off, which most users have.
export function isRebaseBlockedByDirtyTree(
  hasTrackedChanges: boolean,
  rebaseAutoStash: RebaseAutoStashSetting
): boolean {
  return hasTrackedChanges && rebaseAutoStash !== true
}

/** Everything the panel derives about rebasing, so the base row and the menu share one reading. */
export function resolveSourceControlRebaseModel(inputs: BaseRebaseInputs) {
  const baseRebaseState = resolveBaseRebaseState(inputs)
  const rebaseBehindCount = resolveRebaseBehindCount(
    inputs.summary,
    inputs.compareBaseRef,
    inputs.effectiveBaseRef
  )
  return {
    baseRebaseState,
    rebaseBehindCount,
    rebaseBlockedByDirtyTree: isRebaseBlockedByDirtyTree(
      inputs.hasTrackedChanges,
      inputs.rebaseAutoStash
    ),
    rebaseContinueState:
      baseRebaseState.kind === 'rebase_paused' ? baseRebaseState.continueState : null,
    // Read rebase.autoStash only where its answer changes the button: dirty, remote base, maybe behind.
    shouldProbeRebaseAutoStash:
      inputs.hasTrackedChanges &&
      inputs.conflictOperation !== 'rebase' &&
      inputs.effectiveBaseRef?.includes('/') === true &&
      rebaseBehindCount !== 0
  }
}

// A reading for another HEAD is stale until re-read, so Continue waits rather than guessing.
// A failed read only counts for the HEAD it was taken at; a HEAD move reads again on its own.
export function resolveRebaseContinueState(
  rebaseStop: RebaseStopReading | null,
  statusHead: string | null,
  inspectFailure: RebaseStopInspectFailure | null = null,
  indexObservation: string | null = null
): RebaseContinueState {
  if (
    inspectFailure &&
    inspectFailure.head === statusHead &&
    (inspectFailure.indexObservation === undefined ||
      inspectFailure.indexObservation === indexObservation)
  ) {
    return 'unreadable'
  }
  if (!rebaseStop) {
    return 'unknown'
  }
  if (!rebaseStop.token.head || !rebaseStop.token.step || !rebaseStop.token.incarnation) {
    return 'unreadable'
  }
  if (statusHead !== null && rebaseStop.token.head !== statusHead) {
    return 'unknown'
  }
  if (!indexObservation || !rebaseStop.indexObservation) {
    return 'unreadable'
  }
  if (rebaseStop.indexObservation !== indexObservation) {
    return 'unknown'
  }
  return rebaseStop.blocked === 'empty' ? 'empty' : rebaseStop.blocked ? 'blocked' : 'ready'
}

export function resolveBaseRebaseState(inputs: BaseRebaseInputs): BaseRebaseState {
  if (inputs.conflictOperation === 'rebase') {
    const continueState = resolveRebaseContinueState(
      inputs.rebaseStop,
      inputs.statusHead,
      inputs.rebaseStopInspectFailure,
      inputs.indexObservation
    )
    return {
      kind: 'rebase_paused',
      unresolvedCount: inputs.unresolvedConflictCount,
      continueState,
      inspectFailureMessage:
        continueState === 'unreadable' ? (inputs.rebaseStopInspectFailure?.message ?? null) : null
    }
  }
  const behind = resolveRebaseBehindCount(
    inputs.summary,
    inputs.compareBaseRef,
    inputs.effectiveBaseRef
  )
  const baseLabel = inputs.effectiveBaseRef
    ? formatSourceControlRefLabel(inputs.effectiveBaseRef)
    : null
  // Only remote bases are rebase targets; the action fetches the base first.
  if (behind === null || !baseLabel?.includes('/')) {
    return { kind: 'none' }
  }
  if (behind === 0) {
    return { kind: 'up_to_date' }
  }
  return {
    kind: 'behind',
    behind,
    baseLabel,
    blockedBy: inputs.isBusy
      ? 'busy'
      : isRebaseBlockedByDirtyTree(inputs.hasTrackedChanges, inputs.rebaseAutoStash)
        ? 'dirty'
        : null
  }
}
export type SourceControlRebaseModel = ReturnType<typeof resolveSourceControlRebaseModel>
