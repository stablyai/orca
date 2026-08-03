import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export type StatusBarToggleSearchEntry = {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}

export function getOrchestrationUsageStatusBarToggleSearchEntry(): StatusBarToggleSearchEntry {
  return {
    id: 'orchestration-usage',
    title: translate(
      'auto.components.settings.appearance.search.orchestrationUsageTitle',
      'Orchestration Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.orchestrationUsageDescription',
      'Show elapsed time, attributed tokens, and estimated cost for the active workspace orchestration.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.orchestration',
        'orchestration'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.afbb6a3767', 'tokens'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost')
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.orchestrationUsageToggleDescription',
      'Show workspace-scoped orchestration usage and data-quality details.'
    )
  }
}
