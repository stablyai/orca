import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  aiVaultSessionRowResumeGating,
  resolveAiVaultSessionResumeState,
  type AiVaultSessionResumeTargetState
} from '../right-sidebar/ai-vault-session-resume'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo
} from '../right-sidebar/ai-vault-session-worktree'

/**
 * What one card may offer for one session. Deliberately only ids and booleans: the reasons a
 * card shows are translated at render, because a memoized string would go stale on a locale
 * switch the memo never hears about.
 */
export type SessionsBoardCardAvailability = {
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  /** Non-null exactly while the jump affordance is live, so a handler cannot fire blind. */
  jumpWorktreeId: string | null
  resumeWorktreeId: string | null
  resumeDisabled: boolean
  resumeBlocked: boolean
  canCopyResumeCommand: boolean
}

/**
 * The board's answer to "what can this session do", asked the same way the Agent Session
 * History panel asks it.
 *
 * Pure and per-session on purpose: the expensive half (matching a cwd against every open
 * workspace) is hoisted into `useAiVaultSessionWorktreeMap`, so this runs once per session
 * per scan instead of once per card per render.
 */
export function resolveSessionsBoardCardAvailability(args: {
  session: AiVaultSession
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  repos: readonly Repo[]
  ownerWorkspaces: readonly Worktree[]
  targetState: AiVaultSessionResumeTargetState
}): SessionsBoardCardAvailability {
  const resumeState = resolveAiVaultSessionResumeState({
    sessionFilePath: args.session.filePath,
    sessionExecutionHostId: args.session.executionHostId,
    worktreeInfo: args.worktreeInfo,
    // Why permanently null: this board is machine-wide, so "the workspace you happen to have
    // open" is usually not where this session was recorded. Withholding it here rather than
    // gating on it at each call site is what makes the refusal structural — there is no active
    // workspace left for a resume to fall back to.
    activeWorktreeId: null,
    worktrees: args.ownerWorkspaces,
    repos: args.repos,
    targetState: args.targetState
  })
  const gating = aiVaultSessionRowResumeGating(args.session, resumeState)
  return {
    worktreeInfo: args.worktreeInfo,
    jumpWorktreeId: canJumpToAiVaultSessionWorktree(args.worktreeInfo)
      ? (args.worktreeInfo?.worktreeId ?? null)
      : null,
    resumeWorktreeId: gating.resumeDisabled ? null : resumeState.worktreeId,
    resumeDisabled: gating.resumeDisabled,
    resumeBlocked: resumeState.blocked,
    canCopyResumeCommand: gating.canCopyResumeCommand
  }
}
