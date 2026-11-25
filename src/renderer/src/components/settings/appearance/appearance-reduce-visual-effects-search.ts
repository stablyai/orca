import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getReduceVisualEffectsEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.reduceVisualEffects.08c854149e', 'Reduce visual effects'),
    description: translate(
      'settings.appearance.reduceVisualEffects.description',
      'Turn off blur behind dialogs and menus, and window translucency after a restart. Helps remote desktops and machines without a GPU.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.reduceVisualEffects.keywords.blur', 'blur'),
      ...translateSearchKeyword(
        'settings.appearance.reduceVisualEffects.keywords.transparency',
        'transparency'
      ),
      ...translateSearchKeyword(
        'settings.appearance.reduceVisualEffects.keywords.performance',
        'performance'
      ),
      ...translateSearchKeyword(
        'settings.appearance.reduceVisualEffects.keywords.remote',
        'remote'
      ),
      ...translateSearchKeyword('settings.appearance.reduceVisualEffects.keywords.gpu', 'gpu')
    ]
  }
])
