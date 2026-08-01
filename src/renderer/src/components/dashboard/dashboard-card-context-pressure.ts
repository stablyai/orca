import type { DashboardCardContextPressure } from '../../../../shared/dashboard-snapshot'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import type { ContextPressureConfig } from '../../../../shared/agent-context-pressure'
import { resolveEntryContextPressure } from '../sidebar/context-pressure-selection'
import type { DashboardAgentRow } from './useDashboardData'

export function dashboardCardContextPressure(
  row: DashboardAgentRow,
  config: ContextPressureConfig | null
): DashboardCardContextPressure | undefined {
  const pressure = resolveEntryContextPressure(row.entry, config)
  return pressure
    ? {
        level: pressure.level,
        usedPercent: clampUsedPercent(pressure.usedPercent),
        usedTokens: pressure.usedTokens,
        limitTokens: pressure.limitTokens,
        limitSource: pressure.limitSource,
        usedTokensSource: pressure.usedTokensSource
      }
    : undefined
}
