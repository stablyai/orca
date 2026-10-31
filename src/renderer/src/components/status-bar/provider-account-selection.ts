// The account switch the status bar makes, shared with every other place that switches the picker.

import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '../../store'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/codex-session-restart'
import {
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import { getClaudeStatusActiveId } from './status-bar-claude-accounts'
import { getCodexStatusActiveId } from './status-bar-codex-accounts'
import type { CodexStatusRuntimeTarget } from './status-bar-runtime-targets'

type AccountSelection<State> = {
  owner: RuntimeClientTarget
  /** The roster as the caller last read it, so the switch knows which account it leaves. */
  accountState: State
  accountId: string | null
  target: CodexStatusRuntimeTarget
}

/** Selects the account, then offers restarts to live Codex sessions on the one left. */
export async function selectCodexAccountLikeStatusBar(
  selection: AccountSelection<CodexRateLimitAccountsState>
): Promise<CodexRateLimitAccountsState> {
  const { owner, accountState, accountId, target } = selection
  const previous = getCodexStatusActiveId(accountState, target)
  const next = await selectCodexProviderAccount(owner, {
    accountId,
    runtime: target.runtime,
    wslDistro: target.wslDistro
  })
  const store = useAppStore.getState()
  store.recordFeatureInteraction('codex-account-switching')
  // Why: remote selections live on the server; local GlobalSettings are untouched, so refetching is pure churn.
  if (owner.kind === 'local') {
    await store.fetchSettings()
  }
  const nextActive = getCodexStatusActiveId(next, target)
  if (previous !== nextActive) {
    await markLiveCodexSessionsForRestart({
      previousAccountLabel: resolveCodexRestartPromptAccountLabel(accountState.accounts, previous),
      nextAccountLabel: resolveCodexRestartPromptAccountLabel(next.accounts, nextActive),
      // Emails can coincide; IDs determine whether switching returns to the launch account.
      previousAccountId: previous ?? null,
      nextAccountId: nextActive ?? null,
      // Only this owner/runtime slot changed; other lanes keep their current launch accounts.
      owner,
      target,
      // Why: clearing a distro-less WSL row nulls every distro slot at once.
      clearsEveryWslDistro: accountId === null
    })
  }
  return next
}

/** Selects the account, then asks about Claude sessions running on the one left. */
export async function selectClaudeAccountLikeStatusBar(
  selection: AccountSelection<ClaudeRateLimitAccountsState>
): Promise<ClaudeRateLimitAccountsState> {
  const { owner, accountState, accountId, target } = selection
  const previous = getClaudeStatusActiveId(accountState, target)
  const next = await selectClaudeProviderAccount(owner, {
    accountId,
    runtime: target.runtime,
    wslDistro: target.wslDistro
  })
  const store = useAppStore.getState()
  store.recordFeatureInteraction('claude-account-switching')
  if (owner.kind === 'local') {
    await store.fetchSettings()
  }
  const nextActive = getClaudeStatusActiveId(next, target)
  if (previous !== nextActive) {
    void handleRunningClaudeSessionsAfterSwitch({
      owner,
      target,
      before: { state: accountState, accountId: previous },
      after: { state: next, accountId: nextActive }
    })
  }
  return next
}
