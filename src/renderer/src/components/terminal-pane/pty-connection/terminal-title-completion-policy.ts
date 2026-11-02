import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../../shared/agent-status-types'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'

export const shouldSuppressTitleCompletionForFreshHook = (
  title: string,
  activeHookStatus: AgentStatusEntry | undefined
): boolean => {
  if (
    detectAgentStatusFromTitle(title) === 'working' ||
    !isFreshNonDoneAgentStatus(activeHookStatus)
  ) {
    return false
  }
  const explicitTitleAgentType = resolveCommittedTitleAgentType(title)
  const activeHookAgentForTitle = resolveCompatibleAgentTypeForOwner(
    activeHookStatus?.agentType,
    explicitTitleAgentType
  )
  const titleNamesDifferentKnownAgent =
    explicitTitleAgentType &&
    activeHookStatus?.agentType &&
    activeHookStatus.agentType !== 'unknown' &&
    activeHookAgentForTitle !== explicitTitleAgentType
  return !titleNamesDifferentKnownAgent
}
