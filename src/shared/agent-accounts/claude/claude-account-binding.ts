/** The saved Orca account a project's or group's Claude chats and terminals run on. */
export type ClaudeAccountBinding = { kind: 'managed'; accountId: string }

const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,512}$/

/** Malformed values (and kinds this build does not know) return null, so they never become an
 *  account selection. */
export function normalizeClaudeAccountBinding(value: unknown): ClaudeAccountBinding | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const kind = 'kind' in value ? value.kind : undefined
  const accountId = 'accountId' in value ? value.accountId : undefined
  return kind === 'managed' && typeof accountId === 'string' && ACCOUNT_ID.test(accountId)
    ? { kind, accountId }
    : null
}

/** Keeps `null` (clears the binding) and drops a malformed or undefined value, so an update
 *  never unbinds by accident. */
export function sanitizeClaudeAccountUpdate(updates: {
  claudeAccount?: ClaudeAccountBinding | null
}): void {
  if (!('claudeAccount' in updates) || updates.claudeAccount === null) {
    return
  }
  const normalized = normalizeClaudeAccountBinding(updates.claudeAccount)
  if (normalized) {
    updates.claudeAccount = normalized
  } else {
    delete updates.claudeAccount
  }
}
