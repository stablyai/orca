import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getChatErrorEscalationTitle(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.chatErrorEscalationTitle',
    'Tell the coordinator about chat errors'
  )
}

export function getChatErrorEscalationDescription(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.chatErrorEscalationDescription',
    'When a dispatched agent hits an error that ends its turn, send the exact error to the coordinator that dispatched it. The task stays assigned to the agent. Only works for agents running in Chat UI.'
  )
}

export function getChatErrorEscalationSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.orchestration.search.21c28ccdf7', fallback: 'coordinator' },
    { key: 'auto.components.settings.orchestration.search.741dfc03fa', fallback: 'worker' },
    {
      key: 'auto.components.settings.OrchestrationPane.chatErrorEscalationKeywordError',
      fallback: 'error'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.chatErrorEscalationKeywordChat',
      fallback: 'chat'
    }
  ])
}
