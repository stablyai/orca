import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getClaudeStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'claude',
    title: translate('auto.components.settings.appearance.search.9dc15020d7', 'Claude Usage'),
    description: translate(
      'auto.components.settings.appearance.search.de50c6f516',
      'Show Claude token and cost usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.c9fe3a7876', 'claude'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.afbb6a3767', 'tokens'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.dea0a9a665',
        'anthropic'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.claudeToggleDescription',
      'Show Claude token and cost usage for the active workspace.'
    )
  }
}
