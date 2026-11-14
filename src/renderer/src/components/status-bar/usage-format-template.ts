import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { getProviderDisplayName } from '../../../../shared/usage-provider-windows'
import { formatPlanLabel } from './usage-roster-formatting'

export type UsageFormatValues = Record<string, string>

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_.]+)\}/g
// Why: one level of brackets only — nested optional groups aren't worth the parsing cost for a footer string.
const OPTIONAL_GROUP_RE = /\[([^[\]]*)\]/g

/** Replaces known `{key}` placeholders; unknown ones are left verbatim. */
function substitute(text: string, values: UsageFormatValues): string {
  return text.replace(PLACEHOLDER_RE, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match
  )
}

/** Renders `{key}` placeholders; `[...]` groups vanish when any known placeholder inside is empty.
 *  Whitespace is the author's: nothing is collapsed or trimmed, so render it with `whitespace-pre`. */
export function renderUsageFormatTemplate(template: string, values: UsageFormatValues): string {
  const withGroups = template.replace(OPTIONAL_GROUP_RE, (match, inner: string) => {
    const keys = [...inner.matchAll(PLACEHOLDER_RE)].map((m) => m[1])
    if (keys.length === 0) {
      return match
    }
    const missing = keys.some((key) => Object.hasOwn(values, key) && values[key] === '')
    return missing ? '' : substitute(inner, values)
  })
  return substitute(withGroups, values)
}

export type UsageFormatValueOptions = {
  display: UsagePercentageDisplay
  now: number
  /** Test hook; production uses the viewer's zone. */
  timeZone?: string
  locale?: string
}

const WINDOW_KEYS: readonly [
  key: string,
  minutes: number | null,
  pick: (p: ProviderRateLimits) => RateLimitWindow | null | undefined
][] = [
  ['5h', 300, (p) => p.session],
  ['7d', 10080, (p) => p.weekly],
  ['fable', null, (p) => p.fableWeekly],
  ['30d', 43200, (p) => p.monthly]
]

// Same subset and order the built-in Gemini rendering shows.
const BUCKET_ORDER = ['Flash', 'Pro', '1.5 Pro']

/** Window percentage in the user's Used/Remaining preference. */
function percent(window: RateLimitWindow, display: UsagePercentageDisplay): string {
  return `${getDisplayedUsagePercentage(window.usedPercent, display)}%`
}

/** Reset time as a 24h clock string in the viewer's zone. */
function resetClock(resetsAt: number, options: UsageFormatValueOptions): string {
  return new Intl.DateTimeFormat(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: options.timeZone
  }).format(resetsAt)
}

/** Every placeholder the footer template can reference, empty string when the provider lacks it. */
export function buildUsageFormatValues(
  p: ProviderRateLimits,
  options: UsageFormatValueOptions
): UsageFormatValues {
  const values: UsageFormatValues = {
    provider: getProviderDisplayName(p.provider),
    plan: formatPlanLabel(p.planType) ?? ''
  }
  for (const [key, minutes, pick] of WINDOW_KEYS) {
    const candidate = pick(p)
    const window = minutes === null || candidate?.windowMinutes === minutes ? candidate : null
    values[key] = window ? percent(window, options.display) : ''
    values[`${key}.reset`] =
      window?.resetsAt != null ? formatResetDuration(window.resetsAt - options.now) : ''
    values[`${key}.resetAt`] = window?.resetsAt != null ? resetClock(window.resetsAt, options) : ''
  }
  const buckets = (p.buckets ?? [])
    .filter((bucket) => BUCKET_ORDER.includes(bucket.name))
    .sort((a, b) => BUCKET_ORDER.indexOf(a.name) - BUCKET_ORDER.indexOf(b.name))
  values.buckets = buckets
    .map((bucket) => `${bucket.name} ${percent(bucket, options.display)}`)
    .join(' · ')
  return values
}
