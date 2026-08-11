import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getGeminiStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'gemini',
    title: translate('auto.components.settings.appearance.search.5bfb874d05', 'Gemini Usage'),
    description: translate(
      'auto.components.settings.appearance.search.9660c5b2f1',
      'Show Gemini token and cost usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.2804a920ad', 'gemini'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.afbb6a3767', 'tokens'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.51b0ccd6a2', 'google')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.geminiToggleDescription',
      'Show Gemini token and cost usage for the active workspace.'
    )
  }
}
