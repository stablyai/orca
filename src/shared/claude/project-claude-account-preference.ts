export type ProjectClaudeAccountPreference =
  | { mode: 'ask' }
  | { mode: 'account'; accountId: string }

export type RepoAgentAccounts = { claude?: ProjectClaudeAccountPreference }

// Why: a launch that deliberately runs on the active account must stay unpinned on resume too.
export const ACTIVE_CLAUDE_ACCOUNT = '__active__'

const MAX_ACCOUNT_ID_LENGTH = 256

export function isPinnableClaudeAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ACCOUNT_ID_LENGTH &&
    value !== ACTIVE_CLAUDE_ACCOUNT &&
    !value.includes('\u0000')
  )
}

/** A value `launchConfig.claudeAccountId` may carry: a pinnable id or the "active this time" sentinel. */
export function isLaunchConfigClaudeAccountId(value: unknown): value is string {
  return value === ACTIVE_CLAUDE_ACCOUNT || isPinnableClaudeAccountId(value)
}

function normalizeClaudePreference(value: unknown): ProjectClaudeAccountPreference | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const mode = 'mode' in value ? value.mode : undefined
  if (mode === 'ask') {
    return { mode: 'ask' }
  }
  if (mode !== 'account') {
    return null
  }
  const rawId = 'accountId' in value ? value.accountId : undefined
  const accountId = typeof rawId === 'string' ? rawId.trim() : ''
  return isPinnableClaudeAccountId(accountId) ? { mode: 'account', accountId } : null
}

export function normalizeRepoAgentAccounts(value: unknown): RepoAgentAccounts | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const claude = 'claude' in value ? normalizeClaudePreference(value.claude) : null
  return claude ? { claude } : null
}

export function repoAgentAccountsEqual(
  a: RepoAgentAccounts | null | undefined,
  b: RepoAgentAccounts | null | undefined
): boolean {
  const left = a?.claude
  const right = b?.claude
  if (!left || !right) {
    return left === right
  }
  if (left.mode !== right.mode) {
    return false
  }
  return left.mode === 'ask' || (right.mode === 'account' && left.accountId === right.accountId)
}
