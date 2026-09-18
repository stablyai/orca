import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getDevinStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'devin',
    title: translate('auto.components.settings.appearance.search.devinUsageTitle', 'Devin Usage'),
    description: translate(
      'auto.components.settings.appearance.search.devinUsageDescription',
      'Show Devin quota usage from Devin CLI credentials.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.devinKeyword', 'devin'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.cognitionKeyword',
        'cognition'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.devinQuota', 'quota')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.devinToggleDescription',
      'Show Devin quota usage when signed in via Devin CLI.'
    )
  }
}
