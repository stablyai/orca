const PSEUDO_LOCALE = 'en-XA'

export const PSEUDO_LOCALIZATION_LOCALE = PSEUDO_LOCALE

// Why: bracket padding makes untranslated or clipped strings obvious during QA.
export function pseudoLocalizeString(value: string): string {
  if (!value || value.startsWith('[')) {
    return value
  }
  return `[${value}]`
}

export function isPseudoLocalizationLocale(locale: string | undefined): boolean {
  return locale === PSEUDO_LOCALE
}
