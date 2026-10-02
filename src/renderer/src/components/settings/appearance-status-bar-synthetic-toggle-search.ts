import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getSyntheticStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'synthetic',
    title: translate('settings.synthetic.statusBarTitle', 'Synthetic Usage'),
    description: translate(
      'settings.synthetic.statusBarDescription',
      'Show Synthetic five-hour request and weekly credit usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.synthetic',
        'synthetic'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.syntheticQuota',
        'quota'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.syntheticRequests',
        'requests'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.syntheticCredits',
        'credits'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      )
    ],
    toggleDescription: translate(
      'settings.synthetic.statusBarDescription',
      'Show Synthetic five-hour request and weekly credit usage in the status bar.'
    )
  }
}
