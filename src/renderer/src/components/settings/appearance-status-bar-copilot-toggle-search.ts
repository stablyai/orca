import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getCopilotStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'copilot',
    title: translate('auto.components.settings.appearance.search.7a1c3f9d2e', 'Copilot Usage'),
    description: translate(
      'auto.components.settings.appearance.search.b4e8a2d0c6',
      'Show GitHub Copilot premium interactions usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.9f3d7c1a08', 'copilot'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.2c6b8e4f01', 'github'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.copilotToggleDescription',
      'Show GitHub Copilot premium interactions usage when signed in via Copilot CLI.'
    )
  }
}
