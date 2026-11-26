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
  windows: RateLimitWindow[]
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
  return {
    provider: `plugin:${reading.pluginKey}:${reading.providerId}`,
    pluginLabel: reading.label,
    pluginName: reading.pluginName ?? reading.pluginKey,
    pluginIconSrc,
    windows: reading.windows.map((window) => ({ ...window, resetDescription: null })),
    session: null,
    weekly: null,
    updatedAt: reading.observedAt,
    status: 'ok',
    error: null
  }
}
