import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getSshStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'ssh',
    title: translate('auto.components.settings.appearance.search.57fb424c56', 'Remote Hosts'),
    description: translate(
      'auto.components.settings.appearance.search.f17d66d0d2',
      'Show remote host connection status in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.6ecad74eb3', 'ssh'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.a278406ed5', 'remote'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.f4997e0f8a',
        'connection'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.fe192b060e', 'host')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.sshToggleDescription',
      'Show configured SSH and remote Orca hosts when any are available.'
    )
  }
}
