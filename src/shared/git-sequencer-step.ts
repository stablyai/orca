import type { GitConflictOperation } from './git-status-types'

/** The operations with a sequencer to continue; `unknown` names no step to run. */
export type GitSequencerOperation = Exclude<GitConflictOperation, 'unknown'>

export type GitSequencerStep = {
  args: readonly [string, string]
  /** Ref git points at the commit being replayed, and deletes when the sequence ends. */
  marker: string
}

// Why: everything here predates the Git 2.25 baseline (`merge --continue` 2.12,
// REBASE_HEAD 2.17), so no capability probe or fallback is needed.
const CONTINUE_STEPS: Record<GitSequencerOperation, GitSequencerStep> = {
  merge: { args: ['merge', '--continue'], marker: 'MERGE_HEAD' },
  rebase: { args: ['rebase', '--continue'], marker: 'REBASE_HEAD' },
  'cherry-pick': { args: ['cherry-pick', '--continue'], marker: 'CHERRY_PICK_HEAD' }
}

export function isGitSequencerOperation(value: unknown): value is GitSequencerOperation {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick'
}

export function gitSequencerContinueStep(operation: GitSequencerOperation): GitSequencerStep {
  return CONTINUE_STEPS[operation]
}

/**
 * Whether a `--continue` that exited nonzero still moved the sequencer forward.
 *
 * `--continue` exits nonzero when it DID commit the resolution and then stopped on the
 * next commit. The marker naming a DIFFERENT commit is the proof it advanced — unlike
 * HEAD, no concurrent commit in the worktree can touch it, so a refused step can never
 * masquerade as progress. A marker that cleared is not that proof: git exits 0 when it
 * finishes the sequence, so a finished-but-nonzero run means a hook or post-commit step
 * failed and must be reported.
 */
export function gitSequencerAdvanced(
  markerBefore: string | null,
  markerAfter: string | null
): boolean {
  return markerBefore !== null && markerAfter !== null && markerAfter !== markerBefore
}
