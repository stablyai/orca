import type { CodexUsageAccountFilter } from './codex-usage-types'

const MAX_ACCOUNT_ID_LENGTH = 512

export function parseCodexUsageAccountFilterArg(value: unknown): CodexUsageAccountFilter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'all' || record.kind === 'system' || record.kind === 'unattributed') {
    return { kind: record.kind }
  }
  if (record.kind !== 'managed' || typeof record.accountId !== 'string') {
    return null
  }
  const accountId = record.accountId.trim()
  return accountId.length > 0 && accountId.length <= MAX_ACCOUNT_ID_LENGTH
    ? { kind: 'managed', accountId }
    : null
}
