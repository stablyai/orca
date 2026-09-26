import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { RepoAgentAccounts } from '../../../../shared/claude/project-claude-account-preference'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { findLaunchRepo, resolveLaunchClaudeAccountId } from '@/lib/claude-launch-account'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import {
  fetchProviderAccountsSnapshot,
  hasRemoteProviderAccountOwner
} from '@/runtime/runtime-provider-accounts-client'
import { providerAccountMatchesView } from '../settings/provider-account-visibility'
import { requestClaudeAccountPrompt } from './claude-account-prompt-state'
import { claudeAccountPinningUnsupportedReasonInState } from '../settings/repository-claude-account'

export type ClaudeLaunchAccountChoice =
  | { kind: 'default' }
  | { kind: 'account'; accountId: string }
  | { kind: 'cancelled' }

type PromptEligibilityInput = {
  repo: Repo | undefined
  settings: Pick<GlobalSettings, 'askClaudeAccountPerProject'> | null | undefined
}

function claudeAccountPromptMayApply(
  repo: Repo | undefined,
  settings: PromptEligibilityInput['settings']
): repo is Repo {
  if (!repo || repo.connectionId) {
    return false
  }
  const preference = repo.agentAccounts?.claude
  if (preference) {
    return preference.mode === 'ask'
  }
  return settings?.askClaudeAccountPerProject === true
}

type PromptEligibilityState = Parameters<typeof claudeAccountPinningUnsupportedReasonInState>[0]

// Why: a project that cannot pin (SSH, WSL) must not offer a choice its launch would refuse.
function claudeAccountPromptMayApplyInState(
  state: PromptEligibilityState,
  repo: Repo | undefined
): repo is Repo {
  return (
    claudeAccountPromptMayApply(repo, state.settings) &&
    claudeAccountPinningUnsupportedReasonInState(state, repo) === null
  )
}

export function shouldPromptForClaudeAccount(
  input: PromptEligibilityInput & { accounts: ClaudeManagedAccountSummary[] }
): boolean {
  return claudeAccountPromptMayApply(input.repo, input.settings) && input.accounts.length >= 2
}

export async function chooseClaudeLaunchAccount(input: {
  repo: Repo | undefined
  settings: GlobalSettings
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
  updateRepo: (repoId: string, u: { agentAccounts: RepoAgentAccounts }) => unknown
}): Promise<ClaudeLaunchAccountChoice> {
  const { repo } = input
  if (!repo || !shouldPromptForClaudeAccount(input)) {
    return { kind: 'default' }
  }
  const answer = await requestClaudeAccountPrompt({
    projectName: repo.displayName,
    accounts: input.accounts,
    activeAccountId: input.activeAccountId
  })
  if (answer.kind === 'cancelled') {
    return answer
  }
  if (!answer.remember) {
    return { kind: 'account', accountId: answer.accountId }
  }
  try {
    const saved = await Promise.resolve(
      input.updateRepo(repo.id, {
        agentAccounts: { claude: { mode: 'account', accountId: answer.accountId } }
      })
    )
    // Why: if saving failed, still honor the pick for this launch.
    return saved === false ? { kind: 'account', accountId: answer.accountId } : { kind: 'default' }
  } catch {
    return { kind: 'account', accountId: answer.accountId }
  }
}

export async function chooseClaudeLaunchAccountForWorkspace(workspace: {
  repoId?: string
  worktreeId?: string
}): Promise<ClaudeLaunchAccountChoice> {
  const state = useAppStore.getState()
  const repo = findLaunchRepo(state, workspace)
  const { settings } = state
  if (!settings || !claudeAccountPromptMayApplyInState(state, repo)) {
    return { kind: 'default' }
  }
  const routedSettings = getRepoOwnerRoutedSettings(settings, repo)
  let accounts: ClaudeManagedAccountSummary[]
  let activeAccountId: string | null
  try {
    const snapshot = await fetchProviderAccountsSnapshot(routedSettings)
    // Why: fail open to the unprompted launch; main still enforces any saved account.
    if (snapshot.failedProviders?.includes('claude')) {
      return { kind: 'default' }
    }
    const visibility = {
      remoteOwner: hasRemoteProviderAccountOwner(routedSettings),
      ownerPlatform: null
    }
    accounts = snapshot.claude.accounts.filter((account) =>
      providerAccountMatchesView(account, { runtime: 'host' }, visibility)
    )
    activeAccountId =
      snapshot.claude.activeAccountIdsByRuntime?.host ?? snapshot.claude.activeAccountId
  } catch {
    return { kind: 'default' }
  }
  const hostId = getRepoExecutionHostId(repo)
  return chooseClaudeLaunchAccount({
    repo,
    settings,
    accounts,
    activeAccountId,
    updateRepo: (repoId, updates) => useAppStore.getState().updateRepo(repoId, updates, { hostId })
  })
}

// Why: a remembered pick lands in the store, so resolve it there rather than from a caller's repo snapshot.
export async function chooseClaudeLaunchAccountIdForRepo(
  repoId: string
): Promise<string | undefined | null> {
  const choice = await chooseClaudeLaunchAccountForWorkspace({ repoId })
  if (choice.kind === 'cancelled') {
    return null
  }
  return choice.kind === 'account'
    ? choice.accountId
    : resolveLaunchClaudeAccountId(findLaunchRepo(useAppStore.getState(), { repoId }))
}

// Why: launch synchronously when no prompt can apply so menu-close focus handoffs keep today's timing.
export function launchWithClaudeAccountChoice(
  agent: TuiAgent,
  target: { repoId?: string; worktreeId?: string; afterDeferredLaunch?: () => void },
  launch: (claudeAccountId: string | undefined, deferred: boolean) => void
): void {
  const state = useAppStore.getState()
  if (
    agent !== 'claude' ||
    !claudeAccountPromptMayApplyInState(state, findLaunchRepo(state, target))
  ) {
    launch(undefined, false)
    return
  }
  void (async () => {
    const choice = await chooseClaudeLaunchAccountForWorkspace(target)
    if (choice.kind === 'cancelled') {
      return
    }
    launch(choice.kind === 'account' ? choice.accountId : undefined, true)
    target.afterDeferredLaunch?.()
  })()
}
