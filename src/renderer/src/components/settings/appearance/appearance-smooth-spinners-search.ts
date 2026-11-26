import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getSmoothSpinnersEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.smoothSpinners.title', 'Smooth spinners'),
    description: translate(
      'settings.appearance.smoothSpinners.description',
      "Animate loading spinners continuously at your display's refresh rate instead of 12 FPS. Uses slightly more GPU power while agents are working."
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.smoothSpinners.keywords.spinner', 'spinner'),
      ...translateSearchKeyword(
        'settings.appearance.smoothSpinners.keywords.animation',
        'animation'
      ),
      ...translateSearchKeyword('settings.appearance.smoothSpinners.keywords.smooth', 'smooth'),
      ...translateSearchKeyword('settings.appearance.smoothSpinners.keywords.fps', 'fps'),
      ...translateSearchKeyword('settings.appearance.smoothSpinners.keywords.choppy', 'choppy'),
      ...translateSearchKeyword(
        'settings.appearance.smoothSpinners.keywords.refreshRate',
        'refresh rate'
      ),
      ...translateSearchKeyword(
        'settings.appearance.smoothSpinners.keywords.performance',
        'performance'
      )
    ]
  }
])
