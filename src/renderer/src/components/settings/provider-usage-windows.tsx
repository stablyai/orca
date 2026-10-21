import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'

export type ProviderUsageWindowKind = 'session' | 'weekly' | 'monthly'

export type ProviderUsageWindowRow = {
  kind: ProviderUsageWindowKind
  window: RateLimitWindow
}

// Why a labeler and not a label map: labels must resolve during render so they
// follow a language change, and so nothing calls `translate` at module load.
export type ProviderUsageWindowLabeler = (kind: ProviderUsageWindowKind) => string

function windowLabel(kind: ProviderUsageWindowKind, labels?: ProviderUsageWindowLabeler): string {
  const custom = labels?.(kind)
  if (custom) {
    return custom
  }
  if (kind === 'session') {
    return translate('auto.components.settings.providerUsageWindows.session', '5 hours')
  }
  if (kind === 'weekly') {
    return translate('auto.components.settings.providerUsageWindows.weekly', 'Weekly')
  }
  return translate('auto.components.settings.providerUsageWindows.monthly', 'Monthly')
}

function formatWindowReset(window: RateLimitWindow, now: number): string | null {
  if (!window.resetsAt) {
    return null
  }
  const remaining = window.resetsAt - now
  return remaining > 0 ? formatResetDuration(remaining) : null
}

// Why: a window only renders when its data survived the fetcher's mapping, so
// error snapshots and plan-less accounts show exactly the windows they reported.
export function collectProviderUsageWindows(
  usage: ProviderRateLimits | null
): ProviderUsageWindowRow[] {
  const rows: ProviderUsageWindowRow[] = []
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

export function ProviderUsageWindowView({
  row,
  now,
  labels
}: {
  row: ProviderUsageWindowRow
  now: number
  labels?: ProviderUsageWindowLabeler
}): React.JSX.Element {
  const resetLabel = formatWindowReset(row.window, now)
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge variant="secondary">
        <span className="tabular-nums">{Math.round(row.window.usedPercent)}%</span>
      </Badge>
      <span className="text-muted-foreground">
        {windowLabel(row.kind, labels)}
        {resetLabel
          ? translate(
              'auto.components.settings.providerUsageWindows.resetIn',
              ' — resets in {{value0}}',
              { value0: resetLabel }
            )
          : ''}
      </span>
    </div>
  )
}
