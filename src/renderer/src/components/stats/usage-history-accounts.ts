import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { buildClaudeStatusSwitchGroups } from '../status-bar/status-bar-claude-accounts'
import { buildCodexStatusSwitchGroups } from '../status-bar/status-bar-codex-accounts'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { usageHistoryAccountKey } from './usage-history-model'

export function usageHistoryAccountLabels(
  accounts: ProviderAccountsSnapshot | null | undefined
): Map<string, string> {
  const labels = new Map<string, string>()
  if (!accounts) {
    return labels
  }
  const target = { runtime: 'host', wslDistro: null } as const
  const groups = [
    ...(!accounts.failedProviders?.includes('claude')
      ? buildClaudeStatusSwitchGroups(accounts.claude, target).map((group) => ({
          provider: 'claude' as const,
          group
        }))
      : []),
    ...(!accounts.failedProviders?.includes('codex')
      ? buildCodexStatusSwitchGroups(accounts.codex, target).map((group) => ({
          provider: 'codex' as const,
          group
        }))
      : [])
  ]
  for (const { provider, group } of groups) {
    for (const account of group.targets) {
      if (account.id) {
        labels.set(
          usageHistoryAccountKey({ provider, accountId: account.id }),
          `${getAgentLabel(provider)} · ${account.label}${group.runtimeTarget.runtime === 'wsl' ? ` · ${group.label}` : ''}`
        )
      }
    }
  }
  for (const account of accounts.opencode?.accounts ?? []) {
    labels.set(
      usageHistoryAccountKey({ provider: 'opencode', accountId: account.id }),
      `${getAgentLabel('opencode')} · ${account.label}`
    )
  }
  return labels
}

export function usageHistoryAccountLabel(
  row: Pick<UsageHistoryRow, 'provider' | 'accountId'>,
  labels: ReadonlyMap<string, string>
): string {
  if (!row.accountId) {
    return translate('stats.usage.account.unknown', 'Unknown account')
  }
  return (
    labels.get(usageHistoryAccountKey(row)) ??
    `${getAgentLabel(row.provider)} · ${translate('stats.usage.account.recorded', 'Recorded account {{id}}', { id: row.accountId })}`
  )
}
