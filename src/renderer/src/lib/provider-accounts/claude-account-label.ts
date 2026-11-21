import { getManagedAccountInlineLabel } from '../../../../shared/agent-accounts/managed-account-display-names'
import { translate } from '@/i18n/i18n'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/agent-accounts/managed-account-types'

/** Display label for a selected Claude account row; null is System default. */
export function getClaudeAccountLabel(
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return translate('accounts.claude.systemDefault', 'System default')
  }
  const account = state.accounts.find((entry) => entry.id === accountId)
  return account
    ? getManagedAccountInlineLabel(account)
    : translate('accounts.claude.unnamedAccount', 'Claude account')
}

/** Names the login an account was added with once its folder signs in to another one. */
export function getClaudeAccountAddedAsHint(
  account: Pick<ClaudeManagedAccountSummary, 'email' | 'addedAs'>
): string | null {
  const addedAs = account.addedAs
  if (!addedAs) {
    return null
  }
  // One email can hold logins in two organizations; then only the organization tells them apart.
  const sameEmail = addedAs.email.trim().toLowerCase() === account.email.trim().toLowerCase()
  return translate('accounts.claude.addedAs', 'Added as {{value0}}', {
    value0: sameEmail ? (addedAs.organizationName ?? addedAs.email) : addedAs.email
  })
}
