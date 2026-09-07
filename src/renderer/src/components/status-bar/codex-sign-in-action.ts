import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from 'sonner'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { AppState } from '../../store/types'
import { translate } from '@/i18n/i18n'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/codex-session-restart'
import { getCodexStatusActiveId } from './status-bar-codex-accounts'
import type { CodexStatusRuntimeTarget } from './status-bar-runtime-targets'

type CodexSignInActionDependencies = {
  accountState: CodexRateLimitAccountsState
  accountsExpandedRef: MutableRefObject<boolean>
  fetchInactiveCodexAccountUsage: AppState['fetchInactiveCodexAccountUsage']
  fetchSettings: AppState['fetchSettings']
  isSwitching: boolean
  mountedRef: MutableRefObject<boolean>
  reauthenticatingAccountId: string | null
  recordFeatureInteraction: AppState['recordFeatureInteraction']
  setAccounts: Dispatch<SetStateAction<CodexRateLimitAccountsState>>
  setAccountsExpanded: Dispatch<SetStateAction<boolean>>
  setReauthenticatingAccountId: Dispatch<SetStateAction<string | null>>
}

export async function signInCodexAccount(
  accountId: string,
  target: CodexStatusRuntimeTarget,
  dependencies: CodexSignInActionDependencies
): Promise<void> {
  const {
    accountState,
    accountsExpandedRef,
    fetchInactiveCodexAccountUsage,
    fetchSettings,
    isSwitching,
    mountedRef,
    reauthenticatingAccountId,
    recordFeatureInteraction,
    setAccounts,
    setAccountsExpanded,
    setReauthenticatingAccountId
  } = dependencies
  if (isSwitching || reauthenticatingAccountId !== null) {
    return
  }
  const previousActiveAccountId = getCodexStatusActiveId(accountState, target)
  setReauthenticatingAccountId(accountId)
  try {
    const next = await window.api.codexAccounts.reauthenticate({
      accountId,
      // Why: signing in from a signed-out status bar should leave the account
      // usable; the main process still refuses to steal an existing selection.
      activateIfSelectionWasEmpty: true
    })
    recordFeatureInteraction('codex-account-switching')
    if (mountedRef.current) {
      setAccounts(next)
    }
    await fetchSettings()
    const nextActiveAccountId = getCodexStatusActiveId(next, target)
    if (previousActiveAccountId !== nextActiveAccountId) {
      // Why: sign-in that lands on a new active account changes pane credentials
      // exactly like an explicit switch, so it owes the same restart prompt.
      await markLiveCodexSessionsForRestart({
        previousAccountLabel: resolveCodexRestartPromptAccountLabel(
          accountState.accounts,
          previousActiveAccountId
        ),
        nextAccountLabel: resolveCodexRestartPromptAccountLabel(next.accounts, nextActiveAccountId),
        previousAccountId: previousActiveAccountId ?? null,
        nextAccountId: nextActiveAccountId ?? null,
        target
      })
      if (mountedRef.current) {
        setAccountsExpanded(false)
      }
    } else if (mountedRef.current && accountsExpandedRef.current) {
      await fetchInactiveCodexAccountUsage()
    }
    toast.success(
      translate('auto.components.status.bar.StatusBar.codexSignInSuccess', 'Signed in to Codex')
    )
  } catch (error) {
    console.error('Failed to re-authenticate Codex account from status bar:', error)
    toast.error(
      translate(
        'auto.components.status.bar.StatusBar.codexSignInError',
        'Codex sign-in failed. Please try again.'
      )
    )
  } finally {
    if (mountedRef.current) {
      setReauthenticatingAccountId(null)
    }
  }
}
