import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { RebaseAutoStashSetting, RebaseStopReading } from './worktree-operation-store'
import {
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef
} from './branch-context-stats'

export type BaseRebaseState =
  | { kind: 'none' }
  | { kind: 'up_to_date' }
  | { kind: 'behind'; behind: number; baseLabel: string; blockedBy: 'dirty' | 'busy' | null }
  // continueState: unknown until the stop is read for this HEAD; blocked when Git cannot continue it.
  | {
      kind: 'rebase_paused'
      unresolvedCount: number
      continueState: RebaseContinueState
    }

export type RebaseContinueState = 'ready' | 'blocked' | 'unknown'

export type BaseRebaseInputs = {
  summary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  effectiveBaseRef: string | null
  conflictOperation: GitConflictOperation
  unresolvedConflictCount: number
  hasTrackedChanges: boolean
  rebaseAutoStash: RebaseAutoStashSetting
  rebaseStop: RebaseStopReading | null
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
export function resolveRebaseContinueState(
  rebaseStop: RebaseStopReading | null,
  statusHead: string | null
): RebaseContinueState {
  if (!rebaseStop || (statusHead !== null && rebaseStop.token.head !== statusHead)) {
    return 'unknown'
  }
  return rebaseStop.continueBlocked ? 'blocked' : 'ready'
}

export function resolveBaseRebaseState(inputs: BaseRebaseInputs): BaseRebaseState {
  if (inputs.conflictOperation === 'rebase') {
    return {
      kind: 'rebase_paused',
      unresolvedCount: inputs.unresolvedConflictCount,
      continueState: resolveRebaseContinueState(inputs.rebaseStop, inputs.statusHead)
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
