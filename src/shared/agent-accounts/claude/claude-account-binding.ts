/** A project's or group's own Claude account: a saved Orca account, or a config folder the user keeps. */
export type ClaudeAccountBinding =
  | { kind: 'managed'; accountId: string }
  | { kind: 'folder'; configDir: string }

const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,512}$/
const MAX_PATH_LENGTH = 4096

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Malformed values return null so they never become an account selection. */
export function normalizeClaudeAccountBinding(value: unknown): ClaudeAccountBinding | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const kind = 'kind' in value ? value.kind : undefined
  if (kind === 'managed') {
    const accountId = 'accountId' in value ? value.accountId : undefined
    return typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? { kind, accountId } : null
  }
  if (kind === 'folder') {
    const raw = 'configDir' in value ? value.configDir : undefined
    const configDir = typeof raw === 'string' ? raw.trim() : ''
    return configDir &&
      configDir.length <= MAX_PATH_LENGTH &&
      !configDir.includes('\u0000') &&
      isAbsoluteHostPath(configDir)
      ? { kind, configDir }
      : null
  }
  return null
}

/** Keeps `null` (clears the binding) and drops a malformed value so an update never unbinds by accident. */
export function sanitizeClaudeAccountUpdate(updates: {
  claudeAccount?: ClaudeAccountBinding | null
}): void {
  if (updates.claudeAccount == null) {
    return
  }
  const normalized = normalizeClaudeAccountBinding(updates.claudeAccount)
  if (normalized) {
    updates.claudeAccount = normalized
  } else {
    delete updates.claudeAccount
  }
}
