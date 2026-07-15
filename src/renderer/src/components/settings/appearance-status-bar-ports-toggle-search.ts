import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getPortsStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'ports',
    title: translate('auto.components.settings.appearance.search.cf409b6c4d', 'Ports'),
    description: translate(
      'auto.components.settings.appearance.search.0ececfa190',
      'Show live workspace ports in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.006e67b279', 'ports'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.46d21eef62',
        'localhost'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.43cfba3b95', 'server'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.dc02c8759d',
        'workspace'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.portsToggleDescription',
      'Show live workspace ports. Click it for workspace-scoped ports and external listeners.'
    )
  }
}
