import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  bucketWindowKey,
  type StatusBarUsageWindowKey
} from '../../../../shared/status-bar-usage-windows'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import { formatWindowLabel } from '@/lib/window-label-formatter'
import { translate } from '@/i18n/i18n'

export type PickedUsageWindow = {
  key: StatusBarUsageWindowKey
  /** Model group the window belongs to (Antigravity's "Gemini Models"); printed once per run. */
  group: string | null
  label: string
  window: RateLimitWindow
}

// Why weekly leads: it is the budget most plans are metered against, so it reads first.
const NAMED_WINDOW_ORDER = ['weekly', 'session', 'fableWeekly', 'monthly'] as const

// Antigravity names a two-window group "Gemini Models · Weekly Limit Remaining".
const GROUP_SEPARATOR = ' · '

// Why: Antigravity's own session/weekly are its most constrained model group (see
// deriveMostConstrainedWindow), so a bare "wk" would read as one group's limit.
function namedWindowGroup(p: ProviderRateLimits, key: (typeof NAMED_WINDOW_ORDER)[number]) {
  return p.provider === 'antigravity' && (key === 'session' || key === 'weekly')
    ? translate('auto.components.status.bar.statusBarProviderUsage.tightestGroup', 'Tightest')
    : null
}

function bucketPick(bucket: NonNullable<ProviderRateLimits['buckets']>[number]): PickedUsageWindow {
  const separator = bucket.name.indexOf(GROUP_SEPARATOR)
  const group = separator > 0 ? bucket.name.slice(0, separator) : bucket.name
  const rest = separator > 0 ? bucket.name.slice(separator + GROUP_SEPARATOR.length) : bucket.name
  return {
    key: bucketWindowKey(bucket.name),
    group,
    label: bucket.windowMinutes > 0 ? formatWindowLabel(bucket.windowMinutes) : rest,
    window: bucket
  }
}

/** The windows a user pinned for this provider, in footer order; empty means use the default summary. */
export function selectPickedUsageWindows(
  p: ProviderRateLimits,
  keys: readonly StatusBarUsageWindowKey[] | undefined
): PickedUsageWindow[] {
  if (!keys || keys.length === 0) {
    return []
  }
  const picked = new Set(keys)
  const named = NAMED_WINDOW_ORDER.flatMap((key) => {
    const window = p[key]
    if (!picked.has(key) || !window) {
      return []
    }
    const label =
      key === 'fableWeekly'
        ? translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        : formatWindowLabel(window.windowMinutes)
    return [{ key, group: namedWindowGroup(p, key), label, window }]
  })
  const buckets = (p.buckets ?? [])
    .filter((bucket) => picked.has(bucketWindowKey(bucket.name)))
    .map(bucketPick)
  return [...named, ...buckets]
}

/** Every window this snapshot reports, as the picker offers them. */
export function listPickableUsageWindows(p: ProviderRateLimits): PickedUsageWindow[] {
  const keys = [
    ...NAMED_WINDOW_ORDER.filter((key) => p[key]),
    ...(p.buckets ?? []).map((bucket) => bucketWindowKey(bucket.name))
  ]
  return selectPickedUsageWindows(p, keys)
}

export function formatPickedUsageName(pick: PickedUsageWindow): string {
  return pick.group ? `${pick.group} ${pick.label}` : pick.label
}

/** Hover text: the reset countdowns the fixed window names leave out. */
export function formatPickedUsageResets(picks: readonly PickedUsageWindow[], now: number): string {
  return picks
    .filter((pick) => pick.window.resetsAt !== null)
    .map(
      (pick) =>
        `${formatPickedUsageName(pick)}: ${formatResetCountdown((pick.window.resetsAt ?? now) - now)}`
    )
    .join(' · ')
}
