import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getThroughputStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'throughput',
    title: translate(
      'auto.components.settings.appearance.search.throughputTitle',
      'Agent Tokens/sec'
    ),
    description: translate(
      'auto.components.settings.appearance.search.throughputDescription',
      'Show the focused agent’s generation speed in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.afbb6a3767', 'tokens'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.throughputKeyword',
        'throughput'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tokensPerSecondKeyword',
        'tokens per second'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.speedKeyword', 'speed')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.throughputToggleDescription',
      'Show tokens per second for the focused terminal’s agent, measured per completed assistant message.'
    )
  }
}
