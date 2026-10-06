import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
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
    title: translate(
      'auto.components.settings.appearance.search.copilotUsageTitle',
      'Copilot Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.copilotUsageDescription',
      'Show GitHub Copilot premium request usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.copilot', 'copilot'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.github', 'github'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.premiumRequests',
        'premium requests'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.copilotToggleDescription',
      'Show GitHub Copilot premium request usage.'
    )
  }
}
