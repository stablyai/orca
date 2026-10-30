import type { i18n as I18nInstance } from 'i18next'
import { withPluralCategoriesFromOther } from '../i18n-plural-family'
import { structuralValuesEqual } from '../structural-value-equality'
import type { PluginLanguagePackRegistration } from './artifacts/plugin-language-pack-artifact'

/** Re-registers only packs whose catalog changed; returns the resource languages it touched. */
export function replacePluginLanguagePackResources(
  i18n: I18nInstance,
  previous: readonly PluginLanguagePackRegistration[],
  next: readonly PluginLanguagePackRegistration[]
): Set<string> {
  const unchanged = new Set<string>()
  const changed = new Set<string>()
  for (const pack of previous) {
    const replacement = next.find((entry) => entry.resourceLanguage === pack.resourceLanguage)
    if (
      replacement &&
      (replacement === pack || structuralValuesEqual(replacement.catalog, pack.catalog))
    ) {
      unchanged.add(pack.resourceLanguage)
      continue
    }
    i18n.removeResourceBundle(pack.resourceLanguage, 'translation')
    changed.add(pack.resourceLanguage)
  }
  if (changed.size > 0) {
    // removeResourceBundle also drops the namespace that later backend loads read.
    void i18n.loadNamespaces('translation')
  }
  for (const pack of next) {
    if (unchanged.has(pack.resourceLanguage)) {
      continue
    }
    const categories = new Intl.PluralRules(pack.resourceLanguage).resolvedOptions()
      .pluralCategories
    i18n.addResourceBundle(
      pack.resourceLanguage,
      'translation',
      withPluralCategoriesFromOther(pack.catalog, categories),
      true,
      true
    )
    changed.add(pack.resourceLanguage)
  }
  return changed
}
