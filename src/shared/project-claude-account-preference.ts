export type ProjectClaudeAccountPreference =
  | { kind: 'inherit-global' }
  | { kind: 'account'; accountId: string }

export function normalizeProjectClaudeAccountPreference(
  value: unknown
): ProjectClaudeAccountPreference {
  if (!isRecord(value)) {
    return { kind: 'inherit-global' }
  }

  if (value.kind === 'account') {
    const accountId = normalizeAccountId(value.accountId)
    return accountId ? { kind: 'account', accountId } : { kind: 'inherit-global' }
  }

  return { kind: 'inherit-global' }
}

export function getPreferredClaudeAccountId(value: unknown): string | null {
  const preference = normalizeProjectClaudeAccountPreference(value)
  return preference.kind === 'account' ? preference.accountId : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeAccountId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
