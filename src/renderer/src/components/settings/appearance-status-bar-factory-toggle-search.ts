import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getFactoryStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'factory',
    title: translate('auto.components.settings.appearance.search.b3e7c1a9d4', 'Factory AI Usage'),
    description: translate(
      'auto.components.settings.appearance.search.e2a9d4c7f1',
      'Show Factory AI 5-hour, weekly, and monthly usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.c4d8f2e6b0', 'factory'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.e1f7a3c5b9', 'droid'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.a5c2e8f1d3', 'quota')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.factoryToggleDescription',
      'Show Factory AI quota usage when an API key is configured.'
    )
  }
}
