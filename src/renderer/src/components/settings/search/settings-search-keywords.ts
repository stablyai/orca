import { i18n, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type SearchKeywordSpec = {
  key: string
  fallback: string
  /** Extra English aliases kept when UI is localized (brands, acronyms). */
  aliases?: string[]
  /** When true, only the fallback/aliases are indexed — no localized variant. */
  englishOnly?: boolean
}

// Index localized copy alongside English aliases users still type.
export function translateSearchKeyword(
  key: string,
  fallback: string,
  options?: Omit<SearchKeywordSpec, 'key' | 'fallback'>,
  t: Translate = translate
): string[] {
  if (options?.englishOnly || i18n.language === 'en') {
    return uniqueKeywords([fallback, ...(options?.aliases ?? [])])
  }

  const localized = t(key, fallback)
  return uniqueKeywords([localized, fallback, ...(options?.aliases ?? [])])
}

export type SearchKeywordTranslator = (
  key: string,
  fallback: string,
  options?: Omit<SearchKeywordSpec, 'key' | 'fallback'>
) => string[]

/** translateSearchKeyword bound to a render's `t`; name the result translateSearchKeyword so catalog extraction still sees its keys. */
export function searchKeywordTranslator(t: Translate = translate): SearchKeywordTranslator {
  return (key, fallback, options) => translateSearchKeyword(key, fallback, options, t)
}

export function searchKeywords(terms: (string | SearchKeywordSpec)[], t?: Translate): string[] {
  return uniqueKeywords(
    terms.flatMap((term) => {
      if (typeof term === 'string') {
        return [term]
      }
      return translateSearchKeyword(term.key, term.fallback, term, t)
    })
  )
}

export function uniqueKeywords(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function projectGroupingSearchKeywords(t: Translate = translate): string[] {
  return [
    ...translateSearchKeyword('settings.projectGrouping.search.projects', 'projects', undefined, t),
    ...translateSearchKeyword(
      'settings.projectGrouping.search.repository',
      'repository',
      undefined,
      t
    ),
    ...translateSearchKeyword('settings.projectGrouping.search.checkout', 'checkout', undefined, t),
    ...translateSearchKeyword('settings.projectGrouping.search.host', 'host', undefined, t),
    ...translateSearchKeyword('settings.projectGrouping.search.folder', 'folder', undefined, t)
  ]
}
