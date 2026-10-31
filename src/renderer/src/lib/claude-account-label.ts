import { translate } from '@/i18n/i18n'
import { getClaudeManagedAccountLabel } from '../../../shared/claude-managed-account-label'
import type { ClaudeRateLimitAccountsState } from '../../../shared/managed-account-types'

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
    ? getClaudeManagedAccountLabel(account)
    : translate('accounts.claude.unnamedAccount', 'Claude account')
}
