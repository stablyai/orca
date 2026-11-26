// Dates and times read in the UI language but follow the OS region and 12/24-hour clock,
// which the OS keeps separate from the language (English UI, Dutch region, 24-hour clock).

export type OsDateTimeRegion = {
  /** ISO 3166 region or UN M.49 area code, e.g. `NL` or `419`. */
  region: string | null
  /** The OS's 12/24-hour choice when it reports one; null keeps the region's default. */
  hourCycle: 'h12' | 'h23' | null
}

const REGION = /^(?:[A-Za-z]{2}|\d{3})$/
const SCRIPT = /^[A-Za-z]{4}$/
const NO_OS_REGION: OsDateTimeRegion = { region: null, hourCycle: null }

let osDateTimeRegion = NO_OS_REGION
let formatsBuilt = false

export function setOsDateTimeRegion(value: OsDateTimeRegion | null): void {
  const region = value?.region && REGION.test(value.region) ? value.region.toUpperCase() : null
  const hourCycle =
    value?.hourCycle === 'h12' || value?.hourCycle === 'h23' ? value.hourCycle : null
  osDateTimeRegion = { region, hourCycle }
}

export function currentOsDateTimeRegion(): OsDateTimeRegion {
  return osDateTimeRegion
}

/** Whether any date was formatted yet, so a late region only repaints output that exists. */
export function regionalFormatsBuilt(): boolean {
  return formatsBuilt
}

/** Changes exactly when regional formats can change. */
export function osDateTimeRegionKey(): string {
  return `${osDateTimeRegion.region}|${osDateTimeRegion.hourCycle}`
}

/** Region of an OS locale: `en-US@rg=nlzzzz` (macOS region override) → NL, `de_DE.UTF-8` → DE. */
export function osLocaleRegion(tag: string | null | undefined): string | null {
  if (!tag) {
    return null
  }
  const [base = '', modifiers = ''] = tag.trim().split('@')
  const override = /(?:^|;)rg=([a-z]{2})z{4}(?:;|$)/i.exec(modifiers)?.[1]
  if (override) {
    return override.toUpperCase()
  }
  const [, ...subtags] = (base.split('.')[0] ?? '').split(/[-_]/)
  const region = subtags.find((subtag, index) => index < 2 && REGION.test(subtag))
  return region ? region.toUpperCase() : null
}

/** Windows short-time pattern (`HH:mm`, `h:mm tt`) → its hour cycle; `H` is the 24-hour field. */
export function hourCycleFromTimePattern(pattern: string | null | undefined): 'h12' | 'h23' | null {
  const fields = pattern?.replace(/'[^']*'/g, '') ?? ''
  return fields.includes('H') ? 'h23' : fields.includes('h') ? 'h12' : null
}

function maximizedScript(tag: string): string | undefined {
  try {
    return typeof Intl.Locale === 'function' ? new Intl.Locale(tag).maximize().script : undefined
  } catch {
    return undefined
  }
}

/** The UI locale with the OS region: `en` + NL → `en-NL`; keeps the UI's script (`zh` + TW → `zh-Hans-TW`). */
export function withOsRegion(uiLocale: string, region: string | null): string {
  if (!region || !REGION.test(region)) {
    return uiLocale
  }
  const [language = '', first] = uiLocale.split('-')
  let script = first && SCRIPT.test(first) ? first : undefined
  if (!script) {
    const uiScript = maximizedScript(uiLocale)
    script = uiScript !== maximizedScript(`${language}-${region}`) ? uiScript : undefined
  }
  return [language, script, region.toUpperCase()].filter(Boolean).join('-')
}

let runtimeLocale: string | undefined

// `undefined` means the runtime's own language; resolve it so the OS region can still apply.
function resolveLocale(locale: string | undefined): string {
  return locale ?? (runtimeLocale ??= new Intl.DateTimeFormat().resolvedOptions().locale)
}

/** Uncached; for callers that cache per dynamic option such as a time zone (key on osDateTimeRegionKey()). */
export function createRegionalDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale?: string
): Intl.DateTimeFormat {
  formatsBuilt = true
  const uiLocale = resolveLocale(locale)
  const { region, hourCycle } = osDateTimeRegion
  const regional =
    hourCycle && options.hour12 === undefined && options.hourCycle === undefined
      ? { ...options, hourCycle }
      : options
  try {
    const tag = withOsRegion(uiLocale, region)
    const formatter = new Intl.DateTimeFormat(tag, regional)
    // A 24-hour hour alone reads as a bare number ("20"), so it gets its minutes ("20:00").
    const bareHour =
      (region || hourCycle) && options.hour !== undefined && options.minute === undefined
    return bareHour && /^h2[34]$/.test(formatter.resolvedOptions().hourCycle ?? '')
      ? new Intl.DateTimeFormat(tag, { ...regional, minute: '2-digit' })
      : formatter
  } catch {
    return new Intl.DateTimeFormat(uiLocale, options)
  }
}

// Keyed by options identity, then language and OS region: the same constant serves the UI
// language and the runtime default side by side without rebuilding. A handful of keys per options.
const formats = new WeakMap<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>()

/** Cached per options object (pass module constants) and rebuilt when the language or OS region changes. */
export function regionalDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale?: string
): Intl.DateTimeFormat {
  const key = `${locale}|${osDateTimeRegionKey()}`
  let byKey = formats.get(options)
  if (!byKey) {
    byKey = new Map()
    formats.set(options, byKey)
  }
  let formatter = byKey.get(key)
  if (!formatter) {
    formatter = createRegionalDateTimeFormat(options, locale)
    byKey.set(key, formatter)
  }
  return formatter
}

// Shared defaults for converting `toLocaleString`-style calls, whose implicit options these match.
export const DATE_TIME_NUMERIC: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric'
}
export const DATE_NUMERIC: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
}
export const TIME_NUMERIC: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric'
}
export const CLOCK_TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
export const SHORT_MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
export const SHORT_MONTH_DAY_TIME: Intl.DateTimeFormatOptions = {
  ...SHORT_MONTH_DAY,
  ...CLOCK_TIME
}
export const SHORT_WEEKDAY_TIME: Intl.DateTimeFormatOptions = { weekday: 'short', ...CLOCK_TIME }

/** "8:05 PM" today, else "Thu 8:05 PM". */
export function formatTimeOrWeekdayTime(at: Date, now: Date = new Date()): string {
  const today = at.toDateString() === now.toDateString()
  return regionalDateTimeFormat(today ? CLOCK_TIME : SHORT_WEEKDAY_TIME).format(at)
}
