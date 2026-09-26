import type { Repo } from '../../../shared/repo-types'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { AppState } from '@/store/types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { claudeAccountPinningUnsupportedReasonInState } from '@/components/settings/repository-claude-account'

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

/** The launch config a GUI launch carries: Claude's gets the pick, the sentinel or the saved account. */
export function stampClaudeLaunchAccount(
  state: Parameters<typeof claudeAccountPinningUnsupportedReasonInState>[0],
  launch: { agent: TuiAgent; worktreeId: string; claudeAccountId?: string },
  config: SleepingAgentLaunchConfig
): SleepingAgentLaunchConfig {
  if (launch.agent !== 'claude') {
    return config
  }
  const repo = findLaunchRepo(state, { worktreeId: launch.worktreeId })
  // Why: main never pins a saved default on SSH or WSL, so recording one would mislabel the tab.
  if (
    !launch.claudeAccountId &&
    repo &&
    claudeAccountPinningUnsupportedReasonInState(state, repo)
  ) {
    return config
  }
  return withClaudeLaunchAccount(config, resolveLaunchClaudeAccountId(repo, launch.claudeAccountId))
}
