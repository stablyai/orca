import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../search/settings-search-keywords'

export function getCoordinatorApprovalsTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.coordinatorApprovalsTitle',
    'Let coordinators approve worker permission prompts'
  )
}

export function getCoordinatorApprovalsDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.coordinatorApprovalsDescription',
    "A coordinator agent can allow a worker's permission prompt, with a reason. You still see Allow and Deny, and the first answer wins. Applies to workers running on this computer."
  )
}

export function getCoordinatorApprovalsSearchKeywords(): string[] {
  return searchKeywords([
    {
      key: 'auto.components.settings.orchestration.search.21c28ccdf7',
      fallback: 'coordinator'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.coordinatorApprovalsKeywordApprove',
      fallback: 'approve'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.coordinatorApprovalsKeywordPermission',
      fallback: 'permission'
    }
  ])
}
