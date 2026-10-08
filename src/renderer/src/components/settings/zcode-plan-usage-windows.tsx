import { translate } from '@/i18n/i18n'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { Badge } from '../ui/badge'

export type ZcodeUsageWindowKind = 'session' | 'weekly' | 'monthly'

export type ZcodeUsageWindowRow = {
  kind: ZcodeUsageWindowKind
  window: RateLimitWindow
}

function windowLabel(kind: ZcodeUsageWindowKind): string {
  if (kind === 'session') {
    return translate('auto.components.settings.ZcodePlanAccountsSection.window.session', '5 hours')
  }
  if (kind === 'weekly') {
    return translate('auto.components.settings.ZcodePlanAccountsSection.window.weekly', 'Weekly')
  }
  return translate('auto.components.settings.ZcodePlanAccountsSection.window.mcp', 'MCP monthly')
}

function formatWindowReset(window: RateLimitWindow, now: number): string | null {
  if (!window.resetsAt) {
    return null
  }
  const remaining = window.resetsAt - now
  return remaining > 0 ? formatResetDuration(remaining) : null
}

// Why: a window only renders when its data survived the fetcher's mapping, so
// error snapshots and MCP-less plans show exactly the windows they reported.
export function collectZcodeUsageWindows(usage: ProviderRateLimits | null): ZcodeUsageWindowRow[] {
  const rows: ZcodeUsageWindowRow[] = []
  if (usage?.session) {
    rows.push({ kind: 'session', window: usage.session })
  }
  if (usage?.weekly) {
    rows.push({ kind: 'weekly', window: usage.weekly })
  }
  if (usage?.monthly) {
    rows.push({ kind: 'monthly', window: usage.monthly })
  }
  return rows
}

export function ZcodeUsageWindowView({
  row,
  now
}: {
  row: ZcodeUsageWindowRow
  now: number
}): React.JSX.Element {
  const resetLabel = formatWindowReset(row.window, now)
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge variant="secondary">
        <span className="tabular-nums">{Math.round(row.window.usedPercent)}%</span>
      </Badge>
      <span className="text-muted-foreground">
        {windowLabel(row.kind)}
        {resetLabel
          ? translate(
              'auto.components.settings.ZcodePlanAccountsSection.resetIn',
              ' — resets in {{value0}}',
              { value0: resetLabel }
            )
          : ''}
      </span>
    </div>
  )
}
