import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getCommandCodeStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'command-code',
    title: translate(
      'auto.components.settings.appearance.search.commandCodeUsageTitle',
      'Command Code Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.commandCodeUsageDescription',
      'Show Command Code credits and usage windows in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.commandCode',
        'command code'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.commandCodeCredits',
        'credits'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.commandCodeToggleDescription',
      'Show Command Code credits and usage windows.'
    )
  }
}
