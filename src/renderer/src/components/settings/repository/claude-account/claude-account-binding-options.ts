import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ClaudeManagedAccount } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { ManagedAccountDisplayNames } from '../../../../../../shared/agent-accounts/managed-account-display-names'
import { getManagedAccountDisplayName } from '../../../../../../shared/agent-accounts/managed-account-display-names'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Translate } from '@/i18n/use-translate'

// Why: Radix forbids empty item values, so "no binding" needs a sentinel.
export const UNBOUND_BINDING_VALUE = '__unbound__'
const ACCOUNT_PREFIX = 'account:'

export function claudeBindingValue(binding: ClaudeAccountBinding | undefined): string {
  return binding ? `${ACCOUNT_PREFIX}${binding.accountId}` : UNBOUND_BINDING_VALUE
}

export function claudeAccountOptionValue(accountId: string): string {
  return `${ACCOUNT_PREFIX}${accountId}`
}

/** Null clears the binding; undefined is a value no option produces. */
export function claudeBindingFromValue(value: string): ClaudeAccountBinding | null | undefined {
  if (value === UNBOUND_BINDING_VALUE) {
    return null
  }
  return value.startsWith(ACCOUNT_PREFIX)
    ? { kind: 'managed', accountId: value.slice(ACCOUNT_PREFIX.length) }
    : undefined
}

/** This computer's saved Claude accounts a host binding can name. */
export function hostClaudeAccounts(
  settings: Pick<GlobalSettings, 'claudeManagedAccounts'> | null | undefined
): ClaudeManagedAccount[] {
  return (settings?.claudeManagedAccounts ?? []).filter(
    (account) => account.managedAuthRuntime !== 'wsl'
  )
}

export function claudeAccountName(
  account: Pick<ClaudeManagedAccount, 'id' | 'email'>,
  names: ManagedAccountDisplayNames | null | undefined
): string {
  return getManagedAccountDisplayName(names, 'claude', account.id) ?? account.email
}

export function claudeBindingLabel(
  binding: ClaudeAccountBinding,
  accounts: readonly ClaudeManagedAccount[],
  names: ManagedAccountDisplayNames | null | undefined,
  t: Translate
): string {
  const account = accounts.find((candidate) => candidate.id === binding.accountId)
  return account
    ? claudeAccountName(account, names)
    : t('auto.components.settings.RepositoryClaudeAccountSection.missingAccount', 'Removed account')
}

/** Name of the nearest local ancestor with its own binding, which an unbound group inherits. */
export function inheritedClaudeAccountGroupName(
  groups: readonly ProjectGroup[],
  groupId: string
): string | null {
  const local = new Map(
    groups
      .filter((group) => getRepoExecutionHostId(group) === 'local')
      .map((group) => [group.id, group])
  )
  const seen = new Set([groupId])
  // Why the seen set: a corrupt parent chain must not loop forever.
  for (
    let parent = local.get(local.get(groupId)?.parentGroupId ?? '');
    parent && !seen.has(parent.id);
    parent = local.get(parent.parentGroupId ?? '')
  ) {
    seen.add(parent.id)
    if (parent.claudeAccount) {
      return parent.name
    }
  }
  return null
}
