import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import type { PluginUsageReading } from '../../../../../shared/plugins/contributions/plugin-usage-provider-contribution'

export type PluginUsageRosterProvider = Omit<ProviderRateLimits, 'provider'> & {
  provider: `plugin:${string}`
  pluginLabel: string
  pluginName: string
  pluginIconSrc?: string
  accounts: { label: string; plan?: string; windows: PluginUsageWindow[] }[]
  windows: PluginUsageWindow[]
}

type PluginUsageWindow = RateLimitWindow & {
  key: string
  label: string
  rosterLabel: string
}

export type UsageRosterProvider = ProviderRateLimits | PluginUsageRosterProvider

export function isPluginUsageProvider(
  provider: UsageRosterProvider
): provider is PluginUsageRosterProvider {
  return 'pluginLabel' in provider
}

export function duplicateUsageRosterLabels(providers: UsageRosterProvider[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const provider of providers) {
    const label = (
      isPluginUsageProvider(provider)
        ? provider.pluginLabel
        : getProviderDisplayName(provider.provider)
    ).toLowerCase()
    if (seen.has(label)) {
      duplicates.add(label)
    }
    seen.add(label)
  }
  return duplicates
}

export function usageRosterProviderName(
  provider: UsageRosterProvider,
  t: Translate = translate
): string {
  return isPluginUsageProvider(provider)
    ? `${provider.pluginLabel} · ${pluginUsageProviderSource(provider, t)}`
    : getProviderDisplayName(provider.provider)
}

export function pluginUsageProviderSource(
  provider: PluginUsageRosterProvider,
  t: Translate
): string {
  return t('auto.components.status.bar.UsageRosterPanel.pluginProvider', 'Plugin · {{name}}', {
    name: provider.pluginName
  })
}

export function toPluginUsageRosterProvider(
  reading: PluginUsageReading,
  pluginIconSrc?: string
): PluginUsageRosterProvider {
  const accounts = reading.accounts.map(({ label, plan, windows }) => ({
    label,
    plan,
    windows: windows.map((window) => ({
      key: JSON.stringify([label, window.label]),
      label: window.label,
      rosterLabel: reading.accounts.length === 1 ? window.label : `${label} · ${window.label}`,
      usedPercent: window.usedPercent,
      windowMinutes: 0,
      resetsAt: window.resetsAt ?? null,
      resetDescription: null
    }))
  }))
  return {
    provider: `plugin:${reading.pluginKey}:${reading.providerId}`,
    pluginLabel: reading.label,
    pluginName: reading.pluginName ?? reading.pluginKey,
    pluginIconSrc,
    accounts,
    windows: reading.status === 'unavailable' ? [] : accounts.flatMap(({ windows }) => windows),
    session: null,
    weekly: null,
    updatedAt: reading.observedAt,
    status: reading.status,
    error: reading.error ?? null
  }
}
