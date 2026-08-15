import type {
  CodexUsageAccountFilter,
  CodexUsageAccountOption
} from '../../../../shared/codex-usage-types'

export function codexUsageAccountFilterValue(filter: CodexUsageAccountFilter): string {
  return filter.kind === 'managed' ? `managed:${filter.accountId}` : filter.kind
}

export function parseCodexUsageAccountFilter(value: string): CodexUsageAccountFilter | null {
  if (value === 'all' || value === 'system' || value === 'unattributed') {
    return { kind: value }
  }
  if (!value.startsWith('managed:')) {
    return null
  }
  const accountId = value.slice('managed:'.length).trim()
  return accountId ? { kind: 'managed', accountId } : null
}

export function shortCodexUsageAccountId(accountId: string): string {
  return accountId.length <= 8 ? accountId : accountId.slice(0, 8)
}

export function findCodexUsageAccountOption(
  options: readonly CodexUsageAccountOption[],
  filter: CodexUsageAccountFilter
): CodexUsageAccountOption | null {
  if (filter.kind === 'all') {
    return null
  }
  return (
    options.find((option) =>
      filter.kind === 'managed'
        ? option.kind === 'managed' && option.accountId === filter.accountId
        : option.kind === filter.kind
    ) ?? null
  )
}

export function missingCodexUsageAccountOption(
  options: readonly CodexUsageAccountOption[],
  filter: CodexUsageAccountFilter
): CodexUsageAccountOption | null {
  if (filter.kind === 'all' || findCodexUsageAccountOption(options, filter)) {
    return null
  }
  return filter.kind === 'managed'
    ? {
        kind: 'managed',
        accountId: filter.accountId,
        workspaceLabel: null,
        deleted: true
      }
    : { kind: filter.kind }
}

export function resolveCodexUsageAccountOption(
  options: readonly CodexUsageAccountOption[],
  filter: CodexUsageAccountFilter
): CodexUsageAccountOption | null {
  return (
    findCodexUsageAccountOption(options, filter) ?? missingCodexUsageAccountOption(options, filter)
  )
}
