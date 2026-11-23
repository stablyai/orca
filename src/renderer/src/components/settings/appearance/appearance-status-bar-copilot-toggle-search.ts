import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getCopilotStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'copilot',
    title: translate('auto.components.settings.appearance.search.copilotUsage', 'Copilot usage'),
    description: translate(
      'auto.components.settings.appearance.search.copilotUsageDescription',
      'Show GitHub Copilot quota in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.copilot', 'copilot'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.github', 'github')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.copilotToggleDescription',
      'Show Copilot chat, completions, and premium quota from GitHub CLI.'
    )
  }
}
