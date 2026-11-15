import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../search/settings-search-keywords'

export function getOrchestrationStorageTitle(t: Translate = translate): string {
  return t('auto.components.settings.OrchestrationPane.storageTitle', 'Orchestration storage')
}

export function getOrchestrationStorageDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.storageDescription',
    'Disk space the orchestration database uses on this computer, and Reclaim space to return what it no longer needs.'
  )
}

export function getOrchestrationStorageSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.OrchestrationPane.storageKeywordDisk',
      fallback: 'disk space'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.storageKeywordDatabase',
      fallback: 'database'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.storageKeywordReclaim',
      fallback: 'reclaim'
    }
  ])
}
