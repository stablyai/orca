import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getOrchestrationHeartbeatTitle(): string {
  return translate('auto.components.settings.OrchestrationPane.heartbeatTitle', 'Worker heartbeats')
}

export function getOrchestrationHeartbeatDescription(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.heartbeatDescription',
    'Dispatched workers check in every few minutes so the coordinator can tell a working agent from a hung one. Turning this off means fewer messages to the coordinator, but it loses that check-in signal. Applies to workers dispatched after the change.'
  )
}

export function getOrchestrationHeartbeatSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.orchestration.search.21c28ccdf7', fallback: 'coordinator' },
    { key: 'auto.components.settings.orchestration.search.741dfc03fa', fallback: 'worker' },
    {
      key: 'auto.components.settings.OrchestrationPane.heartbeatKeywordHeartbeat',
      fallback: 'heartbeat'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.heartbeatKeywordStalled',
      fallback: 'stalled'
    }
  ])
}
