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
