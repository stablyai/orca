import type { AppState } from '@/store/types'
import { getWorktreeMapFromState } from '@/store/selectors'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export type AiVaultResumeRepoContext = {
  repoId: string | null
  connectionId: string | null
  executionHostId: ReturnType<typeof getExecutionHostIdForWorktree>
}

/** Derives the repo/connection/host context a resumed AI Vault session's
 * worktree belongs to, so agent-session-rules resolution can find a repo's
 * rule overrides instead of silently falling back to global-only rules. */
export function resolveAiVaultResumeAgentSessionRulesContext(args: {
  state: Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo'>
  worktreeId?: string | null
}): AiVaultResumeRepoContext {
  const targetWorktreeId = args.worktreeId ?? args.state.activeWorktreeId
  const worktree = targetWorktreeId && getWorktreeMapFromState(args.state).get(targetWorktreeId)
  const repo = worktree && args.state.repos.find((entry) => entry.id === worktree.repoId)
  return {
    repoId: (worktree ? worktree.repoId : null) ?? null,
    connectionId: (repo ? repo.connectionId : null) ?? null,
    executionHostId: getExecutionHostIdForWorktree(args.state, targetWorktreeId)
  }
}
