import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../search/settings-search-keywords'

export function getOrchestrationNoticesTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.orchestrationNoticesTitle',
    'Show orchestration messages'
  )
}

export function getOrchestrationNoticesDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.orchestrationNoticesDescription',
    'Shows the messages Orca passes between agents: mail cards in chats, and the "You have N orchestration messages" line Orca types into terminal agents. When off, agents still get every message; Orca only hides them from view here.'
  )
}

export function getOrchestrationNoticesSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.OrchestrationPane.orchestrationNoticesKeywordMessages',
      fallback: 'messages'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.orchestrationNoticesKeywordHide',
      fallback: 'hide'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.orchestrationNoticesKeywordMail',
      fallback: 'mail'
    }
  ])
}
