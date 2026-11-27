import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getMistralVibeStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'mistral-vibe',
    title: translate(
      'auto.components.settings.appearance.search.mistralVibeUsage',
      'Mistral Vibe usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.mistralVibeUsageDescription',
      'Show the Mistral Vibe monthly budget in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.mistral', 'mistral'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.vibe', 'vibe'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.mistralVibeToggleDescription',
      'Show Mistral Vibe monthly budget usage from the Vibe CLI sign-in.'
    )
  }
}
