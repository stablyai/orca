import { getIntlLocale } from './i18n'
import { supportedIntlLocale } from './intl-locale-support'

type CachedFormatter<T> = { locale: string; formatter: T }
type FormatterOptions = Intl.DateTimeFormatOptions | Intl.NumberFormatOptions | Intl.CollatorOptions

const dateTimeFormats = new WeakMap<FormatterOptions, CachedFormatter<Intl.DateTimeFormat>>()
const numberFormats = new WeakMap<FormatterOptions, CachedFormatter<Intl.NumberFormat>>()
const collators = new WeakMap<FormatterOptions, CachedFormatter<Intl.Collator>>()

// Module-level formatters would freeze the language active at import; key by options object and rebuild on switches.
function cachedFormatter<T>(
  cache: WeakMap<FormatterOptions, CachedFormatter<T>>,
  options: FormatterOptions,
  intl: { supportedLocalesOf(locale: string): string[] },
  create: (locale: string) => T
): T {
  // getIntlLocale checks DateTimeFormat support; an unsupported collator/number tag would use the OS locale.
  const locale = supportedIntlLocale(getIntlLocale(), intl)
  const cached = cache.get(options)
  if (cached?.locale === locale) {
    return cached.formatter
  }
  const formatter = create(locale)
  cache.set(options, { locale, formatter })
  return formatter
}

export function uiDateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedFormatter(
    dateTimeFormats,
    options,
    Intl.DateTimeFormat,
    (locale) => new Intl.DateTimeFormat(locale, options)
  )
}

export function uiNumberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFormatter(
    numberFormats,
    options,
    Intl.NumberFormat,
    (locale) => new Intl.NumberFormat(locale, options)
  )
}

export function uiCollator(options: Intl.CollatorOptions): Intl.Collator {
  return cachedFormatter(
    collators,
    options,
    Intl.Collator,
    (locale) => new Intl.Collator(locale, options)
  )
}
