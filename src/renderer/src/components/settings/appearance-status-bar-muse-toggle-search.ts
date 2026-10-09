import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getMuseStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'muse',
    title: translate('auto.components.settings.appearance.search.museUsageTitle', 'Muse Usage'),
    description: translate(
      'auto.components.settings.appearance.search.museUsageDescription',
      'Show Muse Code subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.muse', 'muse'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.meta', 'meta')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.museToggleDescription',
      'Show Muse Code subscription usage. Each refresh spends one minimal Muse request.'
    )
  }
}
