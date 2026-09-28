import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { providerUsageEntry, type AccountUsageEntry } from './account-usage-entry'
import {
  buildClaudeStatusSwitchGroups,
  normalizeClaudeStatusRuntimeTarget
} from './status-bar-claude-accounts'
import {
  buildCodexStatusSwitchGroups,
  normalizeCodexStatusRuntimeTarget
} from './status-bar-codex-accounts'
import { getCodexAccountDisplayLabel } from '@/lib/codex-account-display-label'
import { getCodexStatusRuntimeKey } from './status-bar-runtime-targets'

export function buildAccountUsageRoster(input: {
  providers: ProviderRateLimits[]
  accounts: ProviderAccountsSnapshot
  rateLimits: RateLimitState
  ownerKey: string
}): AccountUsageEntry[] {
  const { accounts, rateLimits, ownerKey } = input
  return input.providers.flatMap((provider): AccountUsageEntry[] => {
    if (provider.provider !== 'claude' && provider.provider !== 'codex') {
      return [
        { ...providerUsageEntry(provider), key: JSON.stringify([ownerKey, provider.provider]) }
      ]
    }
    const isClaude = provider.provider === 'claude'
    const target = isClaude
      ? normalizeClaudeStatusRuntimeTarget(accounts.claude, rateLimits.claudeTarget)
      : normalizeCodexStatusRuntimeTarget(accounts.codex, rateLimits.codexTarget)
    const groups = isClaude
      ? buildClaudeStatusSwitchGroups(accounts.claude, target)
      : buildCodexStatusSwitchGroups(accounts.codex, target)
    const claudeLabels = accounts.claude.accounts.map((account) => ({
      id: account.id,
      email: account.email,
      workspaceLabel: account.organizationName
    }))
    const previews = isClaude ? rateLimits.inactiveClaudeAccounts : rateLimits.inactiveCodexAccounts
    const currentKey = getCodexStatusRuntimeKey(target)
    const entries = groups.flatMap((group) =>
      group.targets
        .filter((account) => account.id !== null || (account.active && group.key === currentKey))
        .map((account): AccountUsageEntry => {
          const selected = account.active && group.key === currentKey
          const preview = account.id
            ? previews.find((item) => item.accountId === account.id)
            : undefined
          const limits = selected ? provider : (preview?.rateLimits ?? null)
          const claudeAccount = isClaude
            ? claudeLabels.find((item) => item.id === account.id)
            : undefined
          // Reuse account email/organization disambiguation already used by the Codex switcher.
          const label = claudeAccount
            ? getCodexAccountDisplayLabel(claudeAccount, claudeLabels)
            : account.label
          return {
            key: JSON.stringify([ownerKey, provider.provider, group.key, account.id]),
            provider: provider.provider,
            accountId: account.id,
            label: group.runtimeTarget.runtime === 'wsl' ? `${label} · ${group.label}` : label,
            runtimeTarget: group.runtimeTarget,
            selected,
            limits,
            isFetching: selected ? provider.status === 'fetching' : (preview?.isFetching ?? false),
            updatedAt: limits?.updatedAt ?? 0
          }
        })
    )
    return entries.sort(
      (a, b) =>
        Number(b.selected) - Number(a.selected) || (a.label ?? '').localeCompare(b.label ?? '')
    )
  })
}
