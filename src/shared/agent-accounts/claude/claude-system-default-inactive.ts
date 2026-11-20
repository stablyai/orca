/** Cache id for the host System default row while a saved Claude account is selected. */
export const CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID = 'claude-system-default'

export type InactiveClaudeMenuAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

export type ClaudeUsageRowTarget = {
  id: string | null
  active: boolean
  runtime: 'host' | 'wsl'
}

/**
 * Saved inactive accounts, plus the host System default sentinel when a saved
 * host account is selected. System default itself has no saved id.
 */
export function inactiveClaudeMenuAccounts(
  inactiveSavedAccounts: readonly InactiveClaudeMenuAccount[],
  hostSelectedAccountId: string | null
): InactiveClaudeMenuAccount[] {
  const accounts = inactiveSavedAccounts.map((account) => ({
    id: account.id,
    managedAuthRuntime: account.managedAuthRuntime,
    wslDistro: account.wslDistro,
    wslLinuxAuthPath: account.wslLinuxAuthPath
  }))
  if (
    hostSelectedAccountId &&
    !accounts.some((account) => account.id === CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID)
  ) {
    accounts.push({ id: CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID })
  }
  return accounts
}

/**
 * Host System default is inactive only while another host account is selected.
 * A WSL row with no id is a different login and must not read this sentinel.
 */
export function claudeInactiveUsageAccountId(target: ClaudeUsageRowTarget): string | null {
  if (target.id) {
    return target.id
  }
  if (!target.active && target.runtime === 'host') {
    return CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID
  }
  return null
}

/** Local rows that can show "Not checked" before a reading arrives. */
export function claudeRowCanShowNotChecked(
  target: ClaudeUsageRowTarget,
  hasActiveRuntimeEnvironment: boolean
): boolean {
  if (target.active || hasActiveRuntimeEnvironment) {
    return false
  }
  if (target.id) {
    return true
  }
  return target.runtime === 'host'
}

/** The sentinel is not a saved profile id. */
export function claudeInactiveUsageReadsSystemDefault(accountId: string): boolean {
  return accountId === CLAUDE_SYSTEM_DEFAULT_INACTIVE_ACCOUNT_ID
}
