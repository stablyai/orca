import { getIntlLocale } from './i18n'
import { supportedIntlLocale } from './intl-locale-support'

type CachedFormatter<T> = { locale: string; formatter: T }
type FormatterOptions =
  | Intl.DateTimeFormatOptions
  | Intl.NumberFormatOptions
  | Intl.CollatorOptions
  | Intl.DisplayNamesOptions

const dateTimeFormats = new WeakMap<FormatterOptions, CachedFormatter<Intl.DateTimeFormat>>()
const numberFormats = new WeakMap<FormatterOptions, CachedFormatter<Intl.NumberFormat>>()
const collators = new WeakMap<FormatterOptions, CachedFormatter<Intl.Collator>>()
const displayNames = new WeakMap<FormatterOptions, CachedFormatter<Intl.DisplayNames>>()
const LANGUAGE_NAMES: Intl.DisplayNamesOptions = { type: 'language' }

// Module-level formatters would freeze the language active at import; key by options object and rebuild on switches.
function cachedFormatter<T>(
  cache: WeakMap<FormatterOptions, CachedFormatter<T>>,
  options: FormatterOptions,
  intl: { supportedLocalesOf(locale: string): string[] },
  create: (locale: string) => T,
  intlLocale: string = getIntlLocale()
): T {
  // getIntlLocale checks DateTimeFormat support; an unsupported collator/number tag would use the OS locale.
  const locale = supportedIntlLocale(intlLocale, intl)
  const cached = cache.get(options)
  if (cached?.locale === locale) {
    return cached.formatter
  }
  const formatter = create(locale)
  cache.set(options, { locale, formatter })
  return formatter
}

export function uiDateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  intlLocale?: string
): Intl.DateTimeFormat {
  return cachedFormatter(
    dateTimeFormats,
    options,
    Intl.DateTimeFormat,
    (locale) => new Intl.DateTimeFormat(locale, options),
    intlLocale
  )
}

export function uiNumberFormat(
  options: Intl.NumberFormatOptions,
  intlLocale?: string
): Intl.NumberFormat {
  return cachedFormatter(
    numberFormats,
    options,
    Intl.NumberFormat,
    (locale) => new Intl.NumberFormat(locale, options),
    intlLocale
  )
}

// Intl formatter caches key on option identity, so these must be module constants.
const MINUTE_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'minute',
  unitDisplay: 'long'
}
const HOUR_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'hour',
  unitDisplay: 'long'
}

/** "45 minutes", or "2 hours" for whole hours, in the UI language. */
export function formatMinutesDuration(minutes: number, intlLocale?: string): string {
  return minutes % 60 === 0
    ? uiNumberFormat(HOUR_UNIT_FORMAT, intlLocale).format(minutes / 60)
    : uiNumberFormat(MINUTE_UNIT_FORMAT, intlLocale).format(minutes)
}

export function uiCollator(options: Intl.CollatorOptions, intlLocale?: string): Intl.Collator {
  return cachedFormatter(
    collators,
    options,
    Intl.Collator,
    (locale) => new Intl.Collator(locale, options),
    intlLocale
  )
}

export function languageDisplayName(locale: string, intlLocale?: string): string {
  try {
    return (
      cachedFormatter(
        displayNames,
        LANGUAGE_NAMES,
        Intl.DisplayNames,
        (uiLocale) => new Intl.DisplayNames(uiLocale, LANGUAGE_NAMES),
        intlLocale
      ).of(locale) ?? locale
    )
  } catch {
    return locale
  }
}
