import { z } from 'zod'

/** How a `RelativeTime` (or a relative Table cell) reads: `long` "5 minutes ago", `short`
 *  "5m ago", `duration` "5m" (time since `at`, for "running for" columns). */
export const PLUGIN_RELATIVE_TIME_FORMATS = ['long', 'short', 'duration'] as const
export type PluginRelativeTimeFormat = (typeof PLUGIN_RELATIVE_TIME_FORMATS)[number]

export const pluginRelativeTimeAt = z
  .number()
  .refine(Number.isFinite, 'must be a finite time in milliseconds')
/** A Table cell Orca keeps current: `{ type: 'relative', at }`. */
export const pluginRelativeTimeCellSchema = z
  .object({
    type: z.literal('relative'),
    at: pluginRelativeTimeAt,
    format: z.enum(PLUGIN_RELATIVE_TIME_FORMATS).optional()
  })
  .strict()
export type PluginRelativeTimeCell = z.infer<typeof pluginRelativeTimeCellSchema>

export type PluginRelativeTimeUnit = 'second' | 'minute' | 'hour' | 'day'
const UNIT_MS: [PluginRelativeTimeUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000]
]

/** The largest whole unit for `diffMs` (negative is the past), as Intl.RelativeTimeFormat takes. */
export function pluginRelativeTimeParts(diffMs: number): {
  value: number
  unit: PluginRelativeTimeUnit
} {
  const size = Math.abs(diffMs)
  const [unit, ms] = UNIT_MS.find(([, each]) => size >= each) ?? ['second', 1000]
  return { value: Math.trunc(diffMs / ms), unit }
}

/** When the text next changes: each second under a minute, then per minute, then per hour. */
export function pluginRelativeTimeTickMs(diffMs: number): number {
  const size = Math.abs(diffMs)
  return size < 60_000 ? 1000 : size < 3_600_000 ? 15_000 : 300_000
}

/** The words for `at` seen at `now`, in `locale`; the host and `orca/testing` share this. */
export function formatPluginRelativeTime(
  at: number,
  now: number,
  format: PluginRelativeTimeFormat,
  locale: string
): string {
  const { value, unit } = pluginRelativeTimeParts(at - now)
  if (format === 'duration') {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(
      Math.abs(value)
    )
  }
  return new Intl.RelativeTimeFormat(locale, {
    numeric: format === 'long' ? 'auto' : 'always',
    style: format === 'long' ? 'long' : 'narrow'
  }).format(value, unit)
}
