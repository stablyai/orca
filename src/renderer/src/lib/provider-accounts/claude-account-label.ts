import { getManagedAccountInlineLabel } from '../../../../shared/agent-accounts/managed-account-display-names'
import { translate } from '@/i18n/i18n'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/agent-accounts/managed-account-types'
import { WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID } from '../../../../shared/agent-accounts/workspace-account-binding'

/** Display label for a selected Claude account row; null is System default. */
export function getClaudeAccountLabel(
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>,
  accountId: string | null | undefined
): string {
  if (accountId == null || accountId === WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID) {
    return translate('accounts.claude.systemDefault', 'System default')
  }
  const account = state.accounts.find((entry) => entry.id === accountId)
  return account
    ? getManagedAccountInlineLabel(account)
    : translate('accounts.claude.unnamedAccount', 'Claude account')
}
