import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ClaudeRateLimitAccountsState } from '../../../shared/managed-account-types'
import {
  getClaudeAccountErrorDescription,
  isClaudeAccountCancellation
} from '@/components/settings/accounts-pane-action-errors'

/** The selected account when it needs a sign-in, else the first saved account that does. */
export function claudeAccountToSignIn(state: ClaudeRateLimitAccountsState): string | null {
  const needing = state.accounts.filter((account) => account.needsSignIn)
  const selected = state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
  return (needing.find((account) => account.id === selected) ?? needing[0])?.id ?? null
}

/** Settings' Sign in again: a hidden `claude auth login` into the account's own folder. True once
 *  signed in; a failure says why in a toast, and a cancel says nothing. */
export async function signInToClaudeAccount(accountId: string): Promise<boolean> {
  try {
    await window.api.claudeAccounts.reauthenticate({ accountId })
    // Why: the account rows other surfaces read come from settings, which the sign-in rewrote.
    await useAppStore.getState().fetchSettings()
    return true
  } catch (error) {
    if (!isClaudeAccountCancellation(error)) {
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.2743cdc0af',
          'Claude account update failed.'
        ),
        { description: getClaudeAccountErrorDescription(error) }
      )
    }
    return false
  }
}
