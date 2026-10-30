import type { TOptions } from 'i18next'
import { isCatalogObject } from './plugins/artifacts/plugin-language-pack-artifact'

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

// Mobile callers still name a literal `_one`/`_other` key; with a count, let CLDR pick the form.
export function resolvePluralFamilyKey(key: string, options?: TOptions): string {
  return typeof options?.count === 'number' ? key.replace(PLURAL_SUFFIX_RE, '') : key
}

// Plugin packs often ship only _one/_other; reuse _other so few/many stay in-language (built-ins commit these forms).
export function withPluralCategoriesFromOther(
  catalog: Record<string, unknown>,
  categories: readonly string[]
): Record<string, unknown> {
  const filled: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(catalog)) {
    filled[key] = isCatalogObject(value) ? withPluralCategoriesFromOther(value, categories) : value
    if (typeof value === 'string' && key.endsWith('_other')) {
      const base = key.slice(0, -'_other'.length)
      for (const category of categories) {
        filled[`${base}_${category}`] ??= value
      }
    }
  }
  return filled
}
