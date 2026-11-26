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

let regionClock: { region: string; hourCycle: OsDateTimeRegion['hourCycle'] } | undefined

// The region's own clock, from its main language: ICU has no data for many pairs (en-BR, en-RU)
// and would fall back to the UI language's clock without a word.
function regionHourCycle(region: string | null): OsDateTimeRegion['hourCycle'] {
  if (!region || typeof Intl.Locale !== 'function') {
    return null
  }
  if (regionClock?.region !== region) {
    let hourCycle: OsDateTimeRegion['hourCycle'] = null
    try {
      const { language } = new Intl.Locale(`und-${region}`).maximize()
      const cycle = new Intl.DateTimeFormat(`${language}-${region}`, {
        hour: 'numeric'
      }).resolvedOptions().hourCycle
      hourCycle = cycle === 'h11' || cycle === 'h12' ? 'h12' : cycle ? 'h23' : null
    } catch {
      hourCycle = null
    }
    regionClock = { region, hourCycle }
  }
  return regionClock.hourCycle
}

/** The calls Orca makes on a date format; out-of-range dates read "Invalid Date" as
 *  `toLocaleString` does, instead of throwing in render. */
export type RegionalDateTimeFormat = Pick<
  Intl.DateTimeFormat,
  'format' | 'formatToParts' | 'resolvedOptions'
>

const INVALID_DATE = 'Invalid Date'
// The JavaScript Date range, in ms either side of the epoch.
const MAX_TIME = 8.64e15

function validTime(value: Parameters<Intl.DateTimeFormat['format']>[0]): boolean {
  const time = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : 0
  return Number.isFinite(time) && Math.abs(time) <= MAX_TIME
}

function forgiving(formatter: Intl.DateTimeFormat): RegionalDateTimeFormat {
  return {
    format: (value) => (validTime(value) ? formatter.format(value) : INVALID_DATE),
    formatToParts: (value) =>
      validTime(value)
        ? formatter.formatToParts(value)
        : [{ type: 'literal' as const, value: INVALID_DATE }],
    resolvedOptions: () => formatter.resolvedOptions()
  }
}

// ICU dropped the region when it has no data for this language there (en-BR resolves to en).
function regionDropped(tag: string, region: string | null): boolean {
  try {
    return (
      region !== null &&
      !new Intl.DateTimeFormat(tag).resolvedOptions().locale.split('-').includes(region)
    )
  } catch {
    return false
  }
}

function buildDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  uiLocale: string
): Intl.DateTimeFormat {
  const { region, hourCycle: forced } = osDateTimeRegion
  try {
    const tag = withOsRegion(uiLocale, region)
    // A pair ICU knows keeps its own clock (fr-CA is 24-hour though Canada's main language is not).
    const hourCycle = forced ?? (regionDropped(tag, region) ? regionHourCycle(region) : null)
    const regional =
      hourCycle && options.hour12 === undefined && options.hourCycle === undefined
        ? { ...options, hourCycle }
        : options
    const formatter = new Intl.DateTimeFormat(tag, regional)
    // A 24-hour hour alone reads as a bare number ("20"), so it gets its minutes ("20:00").
    const bareHour =
      (region || forced) && options.hour !== undefined && options.minute === undefined
    return bareHour && /^h2[34]$/.test(formatter.resolvedOptions().hourCycle ?? '')
      ? new Intl.DateTimeFormat(tag, { ...regional, minute: '2-digit' })
      : formatter
  } catch {
    return new Intl.DateTimeFormat(uiLocale, options)
  }
}

/** Uncached; for callers that cache per dynamic option such as a time zone (key on osDateTimeRegionKey()). */
export function createRegionalDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale?: string
): RegionalDateTimeFormat {
  formatsBuilt = true
  return forgiving(buildDateTimeFormat(options, resolveLocale(locale)))
}

// Keyed by options identity, then language and OS region. Live keys are the UI language, its English
// fallback and the runtime default; the cap drops ones left behind by language or zone changes.
const MAX_KEYS_PER_OPTIONS = 4
const JANUARY = new Date(2026, 0, 1)
const JULY = new Date(2026, 6, 1)

// A formatter keeps the zone it was built in; the offsets change when the system zone does.
function systemZoneKey(options: Intl.DateTimeFormatOptions): string {
  return options.timeZone === undefined
    ? `${JANUARY.getTimezoneOffset()}/${JULY.getTimezoneOffset()}`
    : ''
}
const formats = new WeakMap<Intl.DateTimeFormatOptions, Map<string, RegionalDateTimeFormat>>()

/** Cached per options object (pass module constants) and rebuilt when the language, OS region or zone changes. */
export function regionalDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale?: string
): RegionalDateTimeFormat {
  const key = `${locale}|${osDateTimeRegionKey()}|${systemZoneKey(options)}`
  let byKey = formats.get(options)
  if (!byKey) {
    byKey = new Map()
    formats.set(options, byKey)
  }
  let formatter = byKey.get(key)
  if (!formatter) {
    formatter = createRegionalDateTimeFormat(options, locale)
    if (byKey.size >= MAX_KEYS_PER_OPTIONS) {
      byKey.delete(byKey.keys().next().value as string)
    }
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
