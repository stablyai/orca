import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getNestedWorkerDepthTitle(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.nestedWorkerDepthTitle',
    'Nested worker depth'
  )
}

export function getNestedWorkerDepthDescription(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.nestedWorkerDepthDescription',
    'How many generations of dispatched workers may spawn their own workers. 1 keeps the agent tree flat: a coordinator dispatches workers, and those workers do not dispatch.'
  )
}

export function getNestedWorkerDepthSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.general.search.ec5049e510', fallback: 'nested' },
    { key: 'auto.components.settings.orchestration.search.741dfc03fa', fallback: 'worker' },
    { key: 'auto.components.settings.orchestration.search.eee028ae14', fallback: 'dispatch' },
    {
      key: 'auto.components.settings.orchestration.search.f5d39af41e',
      fallback: 'child agents'
    }
  ])
}
