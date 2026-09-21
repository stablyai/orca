import { useMemo } from 'react'
import {
  activeStructuredAgentSessionTurnId,
  hasUnansweredStructuredAgentSessionDispatch
} from '../../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'

const NO_JOURNAL_ITEMS: StructuredAgentSessionState['items'] = []
const NO_SUBMISSIONS: StructuredAgentSessionState['submissions'] = []

export function useStructuredAgentSessionTransportState(
  state: StructuredAgentSessionState,
  enabled: boolean
) {
  const journalItems = enabled ? state.items : NO_JOURNAL_ITEMS
  const submissions = enabled ? state.submissions : NO_SUBMISSIONS
  const fence = enabled ? state.fence : null
  const turnId = activeStructuredAgentSessionTurnId(journalItems)
  const isWorking =
    turnId !== null || hasUnansweredStructuredAgentSessionDispatch(submissions, fence)
  const turnActivity = useMemo(
    () => selectStructuredAgentTurnActivity(journalItems, turnId, enabled ? state.activity : null),
    [enabled, journalItems, state.activity, turnId]
  )
  const turnTiming = useStructuredAgentTurnTiming(
    {
      items: journalItems,
      submissions,
      ...(enabled ? { hostClock: state.hostClock } : {})
    },
    turnId
  )
  return {
    journalItems,
    submissions,
    fence,
    turnId,
    isWorking,
    turnActivity,
    turnTiming,
    backgroundTasks: structuredSessionBackgroundTasksView(
      enabled ? state.backgroundTasks : null,
      turnId
    )
  }
}
