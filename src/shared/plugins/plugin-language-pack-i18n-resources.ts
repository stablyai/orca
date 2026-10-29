import type { i18n as I18nInstance } from 'i18next'
import { withPluralCategoriesFromOther } from '../i18n-plural-family'
import type { PluginLanguagePackRegistration } from './plugin-language-pack-artifact'

export function replacePluginLanguagePackResources(
  i18n: I18nInstance,
  previous: readonly PluginLanguagePackRegistration[],
  next: readonly PluginLanguagePackRegistration[]
): void {
  for (const pack of previous) {
    i18n.removeResourceBundle(pack.resourceLanguage, 'translation')
  }
  for (const pack of next) {
    const categories = new Intl.PluralRules(pack.resourceLanguage).resolvedOptions()
      .pluralCategories
    i18n.addResourceBundle(
      pack.resourceLanguage,
      'translation',
      withPluralCategoriesFromOther(pack.catalog, categories),
      true,
      true
    )
  }
}
