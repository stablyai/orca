import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getOrchestrationPanelExperimentalSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate(
      'auto.components.settings.experimental.search.orchestrationPanel.title',
      'Orchestration panel'
    ),
    description: translate(
      'auto.components.settings.experimental.search.orchestrationPanel.description',
      'Shows which agents each agent is working with, beside its chat or terminal.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrationPanel.orchestration',
        'orchestration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrationPanel.agents',
        'agents'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrationPanel.workers',
        'workers'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrationPanel.manager',
        'manager'
      )
    ],
    targetSectionId: 'experimental-orchestration-panel'
  })
)
