import { normalizeUiLocaleTag } from './ui-locale'
// Dates and times read in the UI language but follow the OS region and 12/24-hour clock,
// which the OS keeps separate from the language (English UI, Dutch region, 24-hour clock).

export type OsDateTimeRegion = {
  /** ISO 3166 region or UN M.49 area code, e.g. `NL` or `419`. */
  region: string | null
  /** The OS's 12/24-hour choice when it reports one; null keeps the region's default. */
  hourCycle: 'h12' | 'h23' | null
}

/** An ISO 3166 region or UN M.49 area subtag. */
export const REGION_SUBTAG = /^(?:[A-Za-z]{2}|\d{3})$/
const SCRIPT = /^[A-Za-z]{4}$/
const NO_OS_REGION: OsDateTimeRegion = { region: null, hourCycle: null }

let osDateTimeRegion = NO_OS_REGION
let regionKey = 'null|null'
let formatsBuilt = false

export function setOsDateTimeRegion(value: OsDateTimeRegion | null): void {
  const region =
    value?.region && REGION_SUBTAG.test(value.region) ? value.region.toUpperCase() : null
  const hourCycle =
    value?.hourCycle === 'h12' || value?.hourCycle === 'h23' ? value.hourCycle : null
  osDateTimeRegion = { region, hourCycle }
  regionKey = `${region}|${hourCycle}`
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
  return regionKey
}

/** Region of an OS locale: `en-US@rg=nlzzzz` (macOS region override) → NL, `de_DE.UTF-8` → DE. */
export function osLocaleRegion(tag: string | null | undefined): string | null {
  if (!tag) {
    return null
  }
  const override = /@(?:.*;)?rg=([a-z]{2})z{4}(?:;|$)/i.exec(tag)?.[1]
  if (override) {
    return override.toUpperCase()
  }
  const normalized = normalizeUiLocaleTag(tag)
  try {
    return normalized ? (new Intl.Locale(normalized).region ?? null) : null
  } catch {
    return null
  }
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

/** The UI locale with the OS region: `en` + NL → `en-NL`; keeps the UI's script (`zh` + TW →
 *  `zh-Hans-TW`), variants and extensions (`en-u-ca-buddhist` + US → `en-US-u-ca-buddhist`). */
function withOsRegion(uiLocale: string, region: string | null): string {
  if (!region) {
    return uiLocale
  }
  const subtags = uiLocale.split('-')
  const singleton = subtags.findIndex((subtag, index) => index > 0 && subtag.length === 1)
  const extensions = singleton === -1 ? [] : subtags.slice(singleton)
  const [language = '', ...rest] = singleton === -1 ? subtags : subtags.slice(0, singleton)
  let script = rest[0] && SCRIPT.test(rest[0]) ? rest.shift() : undefined
  if (rest[0] && REGION_SUBTAG.test(rest[0])) {
    rest.shift()
  }
  if (!script) {
    const uiScript = maximizedScript(uiLocale)
    script = uiScript !== maximizedScript(`${language}-${region}`) ? uiScript : undefined
  }
  return [language, script, region, ...rest, ...extensions].filter(Boolean).join('-')
}

let runtimeLocale: string | undefined

// `undefined` means the runtime's own language; resolve it so the OS region can still apply.
function resolveLocale(locale: string | undefined): string {
  return locale ?? (runtimeLocale ??= new Intl.DateTimeFormat().resolvedOptions().locale)
}

// The region's own clock, from its main language: ICU has no data for many pairs (en-BR, en-RU)
// and would fall back to the UI language's clock without a word.
function regionHourCycle(region: string): OsDateTimeRegion['hourCycle'] {
  try {
    const { language } = new Intl.Locale(`und-${region}`).maximize()
    const cycle = new Intl.DateTimeFormat(`${language}-${region}`, {
      hour: 'numeric'
    }).resolvedOptions().hourCycle
    return cycle === 'h11' || cycle === 'h12' ? 'h12' : cycle ? 'h23' : null
  } catch {
    // Hermes has no Intl.Locale; the phone always sends its clock.
    return null
  }
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
function regionDropped(tag: string, region: string): boolean {
  try {
    return !new Intl.DateTimeFormat(tag).resolvedOptions().locale.split('-').includes(region)
  } catch {
    return false
  }
}

// Maps iterate in insertion order, so the first key is the oldest.
function dropOldest(map: Map<string, unknown>): void {
  for (const key of map.keys()) {
    map.delete(key)
    return
  }
}

type LocalePlan = {
  tag: string
  hourCycle: OsDateTimeRegion['hourCycle']
  /** The OS named a region or clock, so the plan departs from the UI language's defaults. */
  fromOs: boolean
}
// One plan per language and OS region, so a new formatter costs only its own construction.
const MAX_PLANS = 8
const plans = new Map<string, LocalePlan>()

function localePlan(uiLocale: string): LocalePlan {
  const key = `${uiLocale}|${osDateTimeRegionKey()}`
  let plan = plans.get(key)
  if (!plan) {
    const { region, hourCycle: forced } = osDateTimeRegion
    const tag = withOsRegion(uiLocale, region)
    // A pair ICU knows keeps its own clock (fr-CA is 24-hour though Canada's main language is not).
    plan = {
      tag,
      hourCycle: forced ?? (region && regionDropped(tag, region) ? regionHourCycle(region) : null),
      fromOs: region !== null || forced !== null
    }
    if (plans.size >= MAX_PLANS) {
      dropOldest(plans)
    }
    plans.set(key, plan)
  }
  return plan
}

function buildDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  uiLocale: string
): Intl.DateTimeFormat {
  try {
    const { tag, hourCycle, fromOs } = localePlan(uiLocale)
    const regional =
      hourCycle && options.hour12 === undefined && options.hourCycle === undefined
        ? { ...options, hourCycle }
        : options
    const formatter = new Intl.DateTimeFormat(tag, regional)
    // A 24-hour hour alone reads as a bare number ("20"), so it gets its minutes ("20:00").
    const bareHour = fromOs && options.hour !== undefined && options.minute === undefined
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

// Keyed by options identity, then language, OS region and zone. Live keys are the UI language, its
// English fallback, the runtime default and a few explicit zones; the cap drops the oldest.
const MAX_KEYS_PER_OPTIONS = 8
const JANUARY = new Date(2026, 0, 1)
const JULY = new Date(2026, 6, 1)

const ZONE_NAME_RECHECK_MS = 1_000
let zoneName = ''
let zoneNameReadAt = Number.NEGATIVE_INFINITY

// A formatter keeps the zone it was built in. The offsets catch most zone changes at once; the
// IANA name catches zones that share them (Helsinki, Cairo) and costs a formatter, so it is re-read
// at most once a second.
function systemZoneKey(): string {
  const now = Date.now()
  if (now - zoneNameReadAt >= ZONE_NAME_RECHECK_MS) {
    zoneNameReadAt = now
    zoneName = new Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  }
  return `${zoneName}/${JANUARY.getTimezoneOffset()}/${JULY.getTimezoneOffset()}`
}

// A formatter built inside the recheck window may already be in a newer zone; file it under that.
function builtZoneKey(formatter: RegionalDateTimeFormat): string {
  const built = formatter.resolvedOptions().timeZone
  if (built && built !== zoneName) {
    zoneName = built
    zoneNameReadAt = Date.now()
  }
  return systemZoneKey()
}
const formats = new WeakMap<Intl.DateTimeFormatOptions, Map<string, RegionalDateTimeFormat>>()

/** Cached per options object (pass module constants) and rebuilt when the language, OS region or
 *  zone changes. `timeZone` formats in that zone instead of the system's. */
export function regionalDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale?: string,
  timeZone?: string
): RegionalDateTimeFormat {
  const systemZone = timeZone === undefined && options.timeZone === undefined
  const zone = timeZone ?? (systemZone ? systemZoneKey() : '')
  let key = `${locale}|${osDateTimeRegionKey()}|${zone}`
  let byKey = formats.get(options)
  if (!byKey) {
    byKey = new Map()
    formats.set(options, byKey)
  }
  let formatter = byKey.get(key)
  if (!formatter) {
    formatter = createRegionalDateTimeFormat(timeZone ? { ...options, timeZone } : options, locale)
    if (systemZone) {
      key = `${locale}|${osDateTimeRegionKey()}|${builtZoneKey(formatter)}`
    }
    if (byKey.size >= MAX_KEYS_PER_OPTIONS) {
      dropOldest(byKey)
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
