import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getNousStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'nous',
    title: translate(
      'auto.components.settings.appearance.status.bar.nous.toggle.search.e1f3cf3042',
      'Nous Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.status.bar.nous.toggle.search.06772dccab',
      'Show Nous Portal subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.nous.toggle.search.cd4ad1de8a',
        'nous'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.nous.toggle.search.803915a64d',
        'hermes'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.nous.toggle.search.da8fcec43f',
        'credits'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.nous.toggle.search.f2ad6c2b3d',
        'balance'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.status.bar.nous.toggle.search.6beb71128d',
        'portal'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.nousToggleDescription',
      'Show Nous Portal subscription credit usage when signed in via Hermes.'
    )
  }
}
