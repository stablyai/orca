import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getOllamaCloudStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'ollama-cloud',
    title: translate(
      'auto.components.settings.appearance.search.ollamaCloudUsage',
      'Ollama Cloud Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.ollamaCloudUsageDesc',
      'Show Ollama Cloud subscription usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.ollama', 'ollama'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.25e51b62ee',
        'rate limit'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.ollamaCloudToggleDescription',
      'Show Ollama Cloud subscription usage for the active workspace.'
    )
  }
}
