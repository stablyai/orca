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
    title: translate('settings.appearance.statusBar.museTitle', 'Muse Usage'),
    description: translate(
      'settings.appearance.statusBar.museDescription',
      'Show Meta Muse subscription quota in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.lib.agent.catalog.muse_label', 'Muse', {
        aliases: ['Meta']
      }),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.museToggleDescription',
      'Show Muse subscription quota from the Muse CLI.'
    )
  }
}
