import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from 'sonner'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { AppState } from '../../store/types'
import { translate } from '@/i18n/i18n'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/agent-session/accounts/codex/codex-session-restart'
import { getRuntimeSentenceLabel } from '@/lib/provider-accounts/account-runtime-label'
import { refreshProviderAccountLists } from './use-provider-account-list'
import { getCodexStatusActiveId } from './status-bar-codex-accounts'
import {
  getCodexStatusRuntimeLabel,
  type CodexStatusRuntimeTarget
} from './status-bar-runtime-targets'

type CodexSignInActionDependencies = {
  accountState: CodexRateLimitAccountsState
  menuOpenRef: MutableRefObject<boolean>
  fetchInactiveCodexAccountUsage: AppState['fetchInactiveCodexAccountUsage']
  fetchSettings: AppState['fetchSettings']
  isSwitching: boolean
  mountedRef: MutableRefObject<boolean>
  reauthenticatingAccountId: string | null
  recordFeatureInteraction: AppState['recordFeatureInteraction']
  setAccounts: (accounts: CodexRateLimitAccountsState) => void
  setReauthenticatingAccountId: Dispatch<SetStateAction<string | null>>
}

export async function signInCodexAccount(
  accountId: string,
  target: CodexStatusRuntimeTarget,
  dependencies: CodexSignInActionDependencies
): Promise<void> {
  const {
    accountState,
    menuOpenRef,
    fetchInactiveCodexAccountUsage,
    fetchSettings,
    isSwitching,
    mountedRef,
    reauthenticatingAccountId,
    recordFeatureInteraction,
    setAccounts,
    setReauthenticatingAccountId
  } = dependencies
  if (isSwitching || reauthenticatingAccountId !== null) {
    return
  }
  const previousActiveAccountId = getCodexStatusActiveId(accountState, target)
  // The result can land after the user moved to another host, so the toast names its runtime.
  const runtimeLabel = getRuntimeSentenceLabel({
    runtime: target.runtime,
    // The same name the runtime's tab shows.
    label: getCodexStatusRuntimeLabel(target)
  })
  setReauthenticatingAccountId(accountId)
  try {
    const next = await window.api.codexAccounts.reauthenticate({
      accountId,
      // Activate a newly signed-in account only if selection remains empty; main preserves an existing selection.
      activateIfSelectionWasEmpty: true
    })
    recordFeatureInteraction('codex-account-switching')
    if (mountedRef.current) {
      setAccounts(next)
    }
    await fetchSettings()
    const nextActiveAccountId = getCodexStatusActiveId(next, target)
    if (previousActiveAccountId !== nextActiveAccountId) {
      // A changed active login needs the same pane-restart prompt as an explicit account switch.
      await markLiveCodexSessionsForRestart({
        previousAccountLabel: resolveCodexRestartPromptAccountLabel(
          accountState.accounts,
          previousActiveAccountId
        ),
        nextAccountLabel: resolveCodexRestartPromptAccountLabel(next.accounts, nextActiveAccountId),
        previousAccountId: previousActiveAccountId ?? null,
        nextAccountId: nextActiveAccountId ?? null,
        // Why: reauthenticate is local IPC, so only this computer's panes changed.
        owner: { kind: 'local' },
        target
      })
    } else if (mountedRef.current && menuOpenRef.current) {
      await fetchInactiveCodexAccountUsage()
    }
    toast.success(
      translate(
        'auto.components.status.bar.StatusBar.codexSignInSuccessOnRuntime',
        'Signed in to Codex on {{runtime}}',
        { runtime: runtimeLabel }
      )
    )
  } catch (error) {
    console.error('Failed to re-authenticate Codex account from status bar:', error)
    // Why: a failed sign-in may still have changed the stored login.
    refreshProviderAccountLists({ kind: 'local' }, 'codex', 'unknown')
    await fetchSettings().catch(() => {})
    toast.error(
      translate(
        'auto.components.status.bar.StatusBar.codexSignInFailedOnRuntime',
        'Codex sign-in failed on {{runtime}}.',
        { runtime: runtimeLabel }
      )
    )
  } finally {
    if (mountedRef.current) {
      setReauthenticatingAccountId(null)
    }
  }
}
