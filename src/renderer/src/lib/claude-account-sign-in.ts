import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getClaudeAccountErrorDescription,
  isClaudeAccountCancellation
} from '@/components/settings/accounts-pane-action-errors'

/** Sign in again via hidden claude auth login in the account folder; toast failures and keep cancellation silent. */
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
