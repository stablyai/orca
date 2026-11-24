import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../../search/settings-search-keywords'

export function getWorkerTabsSettingTitle(t: Translate = translate): string {
  return t('workerTabs.setting.title', 'Worker tabs')
}

export function getWorkerTabsSettingDescription(t: Translate = translate): string {
  return t(
    'workerTabs.setting.description',
    'Give workers a tab only when you open them, or always.'
  )
}

export function getWorkerTabsSettingKeywords(t: Translate = translate): string[] {
  return searchKeywords([
    t('workerTabs.setting.keywordWorker', 'worker'),
    t('workerTabs.setting.keywordOrchestration', 'orchestration'),
    t('workerTabs.setting.keywordCoordinator', 'coordinator'),
    t('workerTabs.setting.keywordHideTabs', 'hide tabs')
  ])
}
