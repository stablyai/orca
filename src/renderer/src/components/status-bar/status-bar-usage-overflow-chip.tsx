import type React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageWindowKey } from '../../../../shared/status-bar-usage-windows'
import {
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT,
  clampUsedPercent,
  getProviderDisplayName
} from './tooltip'
import { getTightestUsageSection } from './UsageRosterPanel'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import {
  formatPickedUsageName,
  selectPickedUsageWindows,
  type PickedUsageWindow
} from './status-bar-provider-usage'

export type UsageTone = 'urgent' | 'warning' | 'normal'

/** Urgency by consumption, matching the usage bar colors, whatever % display the user chose. */
export function getUsageTone(
  p: ProviderRateLimits,
  pickedWindows?: readonly StatusBarUsageWindowKey[]
): UsageTone {
  const used = getFooterUsedPercent(p, pickedWindows) ?? 0
  return used >= USAGE_URGENT_PERCENT
    ? 'urgent'
    : used >= USAGE_WARNING_PERCENT
      ? 'warning'
      : 'normal'
}

export function maxPickedUsedPercent(picks: readonly PickedUsageWindow[]): number | null {
  return picks.length > 0
    ? Math.max(...picks.map((pick) => clampUsedPercent(pick.window.usedPercent)))
    : null
}

/** The consumption the footer summarizes: the user's pinned windows when set, else the tightest. */
function getFooterUsedPercent(
  p: ProviderRateLimits,
  pickedWindows?: readonly StatusBarUsageWindowKey[]
): number | null {
  const picked = maxPickedUsedPercent(selectPickedUsageWindows(p, pickedWindows))
  if (picked !== null) {
    return picked
  }
  const tightest = getTightestUsageSection(p)
  return tightest ? clampUsedPercent(tightest.window.usedPercent) : null
}

/**
 * Stands in for usage chips a narrow bar can't fit. Always rendered at the collapsing
 * density so its width is known before anything collapses; out of the row while empty.
 */
export function UsageOverflowChip({
  hidden,
  display,
  pickedWindowsFor
}: {
  hidden: readonly ProviderRateLimits[]
  display: UsagePercentageDisplay
  pickedWindowsFor?: (p: ProviderRateLimits) => readonly StatusBarUsageWindowKey[] | undefined
}): React.JSX.Element {
  const tones = hidden.map((p) => getUsageTone(p, pickedWindowsFor?.(p)))
  const tone = tones.includes('urgent')
    ? 'urgent'
    : tones.includes('warning')
      ? 'warning'
      : 'normal'
  const names = hidden
    .map((p) => {
      const name = getProviderDisplayName(p.provider)
      const picks = selectPickedUsageWindows(p, pickedWindowsFor?.(p))
      if (picks.length > 0) {
        const readings = picks.map(
          (pick) =>
            `${formatPickedUsageName(pick)} ${formatUsagePercentageLabel(pick.window.usedPercent, display)}`
        )
        return `${name} ${readings.join(' · ')}`
      }
      const used = getFooterUsedPercent(p)
      return used !== null ? `${name} ${formatUsagePercentageLabel(used, display)}` : name
    })
    .join(', ')
  return (
    <span
      data-usage-more
      data-usage-collapsed={hidden.length === 0}
      data-tone={tone}
      aria-hidden={hidden.length === 0}
      title={translate(
        'auto.components.status.bar.StatusBar.hiddenUsageProviders',
        'Also: {{value0}}',
        {
          value0: names
        }
      )}
      className="inline-flex h-4 items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground data-[tone=urgent]:border-destructive/40 data-[tone=urgent]:text-destructive data-[tone=warning]:border-status-warning-border data-[tone=warning]:text-status-warning data-[usage-collapsed=true]:invisible data-[usage-collapsed=true]:absolute"
    >
      +{Math.max(1, hidden.length)}
    </span>
  )
}
