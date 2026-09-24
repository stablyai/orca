import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { SettingsSearchEntry } from './settings-search'

const CUSTOM_CSS_KEYWORDS = ['css', 'custom css', 'stylesheet', 'theme', 'colors', 'palette']

const getCustomCssEntryCatalog = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.customCss.title', 'Custom CSS'),
    description: translate(
      'settings.appearance.customCss.description',
      'Load ~/.orca/custom.css on top of the built-in theme. Changes apply as soon as you save the file.'
    ),
    // Why: CSS vocabulary is English in every locale, like the file itself.
    keywords: [...CUSTOM_CSS_KEYWORDS]
  }
])

/** Desktop-only: the web client cannot reach the host's ~/.orca folder. */
export function getCustomCssEntries(): SettingsSearchEntry[] {
  return isWebClientLocation() ? [] : getCustomCssEntryCatalog()
}
