import { i18n } from './i18n'

// Why: search metadata and catalogs call translate() during build. Caching per
// active locale keeps lookups cheap while still refreshing after language changes.
export function createLocalizedCatalog<T>(builder: () => T): () => T {
  let cachedLocale: string | undefined
  let cachedValue: T | undefined

  return () => {
    if (cachedLocale !== i18n.language || cachedValue === undefined) {
      cachedLocale = i18n.language
      cachedValue = builder()
    }
    return cachedValue
  }
}
