import { i18n } from './i18n'
import { getTranslationResourceVersion } from './translation-resource-version'

export function createLocalizedCatalog<T>(builder: () => T): () => T {
  let cachedLocale: string | undefined
  let cachedResourceVersion = -1
  let cachedValue: T | undefined

  return () => {
    const resourceVersion = getTranslationResourceVersion()
    if (
      cachedLocale !== i18n.language ||
      cachedResourceVersion !== resourceVersion ||
      cachedValue === undefined
    ) {
      cachedValue = builder()
      cachedLocale = i18n.language
      cachedResourceVersion = resourceVersion
    }
    return cachedValue
  }
}
