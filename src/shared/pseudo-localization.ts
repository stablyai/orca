const PSEUDO_LOCALE = 'en-XA'

export const PSEUDO_LOCALIZATION_LOCALE = PSEUDO_LOCALE

const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  c: 'ç',
  n: 'ñ'
}

// Why: bracket padding makes untranslated or clipped strings obvious during QA; `expand` also
// accents letters and adds ~40% length, the growth German and Russian copy typically needs.
export function pseudoLocalizeString(value: string, options?: { expand?: boolean }): string {
  if (!value || value.startsWith('[')) {
    return value
  }
  if (!options?.expand) {
    return `[${value}]`
  }
  const accented = value.replace(/[aeiouAEIOUcn]/g, (letter) => ACCENTED[letter] ?? letter)
  return `[${accented}${'·'.repeat(Math.ceil(value.length * 0.4))}]`
}

export function isPseudoLocalizationLocale(locale: string | undefined): boolean {
  return locale === PSEUDO_LOCALE
}
