import type { JSX } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  isPluginUsageProvider,
  pluginUsageProviderSource,
  usageRosterProviderName,
  type PluginUsageRosterProvider,
  type UsageRosterProvider
} from './plugin-usage-roster-provider'
import { formatPlanLabel } from './usage-roster-formatting'

export function PluginUsageProviderName({
  provider
}: {
  provider: PluginUsageRosterProvider
}): JSX.Element {
  const t = useTranslate()
  return (
    <span className="flex min-w-0 flex-col whitespace-normal wrap-anywhere">
      <span className="font-medium text-foreground">{provider.pluginLabel}</span>
      <span className="text-[11px] text-muted-foreground">
        {pluginUsageProviderSource(provider, t)}
      </span>
    </span>
  )
}

export function UsageRosterProviderName({
  provider,
  showDetails,
  showPluginSource
}: {
  provider: UsageRosterProvider
  showDetails: boolean
  showPluginSource: boolean
}): JSX.Element {
  const t = useTranslate()
  const plugin = isPluginUsageProvider(provider)
  if (plugin && showPluginSource) {
    return (
      <div className="min-w-0 text-[13px]">
        <PluginUsageProviderName provider={provider} />
      </div>
    )
  }
  const plan = plugin ? null : formatPlanLabel(provider.planType, provider.provider)
  return (
    <span
      className={cn(
        'shrink truncate text-[13px] font-medium text-foreground',
        showDetails ? 'min-w-0' : 'min-w-14'
      )}
    >
      {plugin ? provider.pluginLabel : usageRosterProviderName(provider, t)}
      {plan ? <span className="font-normal text-muted-foreground"> · {plan}</span> : null}
    </span>
  )
}
