import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getOrchestrationPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.orchestration.search.c34045764e',
      'Agent Orchestration'
    ),
    description: translate(
      'auto.components.settings.orchestration.search.e05ff36753',
      'Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.a7f76b4ca7',
        'orchestration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.d86705ba77',
        'multi-agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.13ba5c6cbd',
        'agents'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.91fc8ab7e5',
        'coordination'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.9a5ebdca31',
        'messaging'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.eee028ae14',
        'dispatch'
      ),
      ...translateSearchKeyword('auto.components.settings.orchestration.search.7ad948b714', 'task'),
      ...translateSearchKeyword('auto.components.settings.orchestration.search.ca54c69806', 'DAG'),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.741dfc03fa',
        'worker'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.21c28ccdf7',
        'coordinator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.32c5098e7b',
        'claude'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.f278fd04db',
        'codex'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.08c65b12a2',
        'examples'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.c766a01978',
        'handoff'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.orchestration.search.f5d39af41e',
        'child agents'
      )
    ]
  }
])
