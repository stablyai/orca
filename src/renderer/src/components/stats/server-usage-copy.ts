import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

/** True while Stats & Usage reads a paired server: its logs are the server's, not this computer's. */
export function useStatsReadsServer(): boolean {
  return useAppStore((state) => state.statsHost.kind !== 'local')
}

export function serverUsageLogsDescription(provider: string): string {
  return translate(
    'auto.components.stats.StatsPane.serverUsageLogsDescription',
    'Reads {{provider}} usage logs on this server to show token, model, and session stats.',
    { provider }
  )
}

export function serverNoUsageForScope(provider: string): string {
  return translate(
    'auto.components.stats.StatsPane.serverNoUsageForScope',
    'No {{provider}} usage found on this server yet for this scope.',
    { provider }
  )
}

/** A provider pane's scope choices, with "all usage" naming the server instead of this computer. */
export function serverScopeOptions<Scope extends string>(
  options: readonly { value: Scope; label: string }[],
  provider: string
): { value: Scope; label: string }[] {
  return options.map((option) =>
    option.value === 'all'
      ? {
          value: option.value,
          label: translate(
            'auto.components.stats.StatsPane.serverAllUsageScope',
            'All {{provider}} usage on this server',
            { provider }
          )
        }
      : option
  )
}
