import type { Repo } from '../../../shared/repo-types'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { AppState } from '@/store/types'
import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'

export function resolveLaunchClaudeAccountId(
  repo: Pick<Repo, 'agentAccounts'> | undefined,
  explicit?: string
): string | undefined {
  if (explicit) {
    return explicit
  }
  const preference = repo?.agentAccounts?.claude
  return preference?.mode === 'account' ? preference.accountId : undefined
}

export function withClaudeLaunchAccount(
  config: SleepingAgentLaunchConfig,
  accountId: string | undefined
): SleepingAgentLaunchConfig {
  return accountId ? { ...config, claudeAccountId: accountId } : config
}

export function findLaunchRepo(
  state: Partial<Pick<AppState, 'repos' | 'worktreesByRepo'>>,
  workspace: { repoId?: string; worktreeId?: string }
): Repo | undefined {
  const { worktreeId } = workspace
  const repoId =
    workspace.repoId ??
    (worktreeId
      ? ((state.worktreesByRepo &&
          getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.repoId) ??
        getRepoIdFromWorktreeId(worktreeId))
      : undefined)
  return repoId && state.repos ? getIndexedRepoMap(state.repos).get(repoId) : undefined
}
