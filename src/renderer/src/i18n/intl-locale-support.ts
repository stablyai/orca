import { DEFAULT_LOCALE } from './supported-languages'

export function supportedIntlLocale(
  locale: string,
  intl: { supportedLocalesOf(locale: string): string[] }
): string {
  try {
    // An unsupported tag would silently use the runtime locale; explicitly fall back to the default.
    return intl.supportedLocalesOf(locale)[0] ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}
