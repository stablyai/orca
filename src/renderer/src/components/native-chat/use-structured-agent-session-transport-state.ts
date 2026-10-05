import { useMemo } from 'react'
import { NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT } from '../../../../shared/native-chat-async-questions'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'

const NO_JOURNAL_ITEMS: StructuredAgentSessionState['items'] = []
const NO_SUBMISSIONS: StructuredAgentSessionState['submissions'] = []
const NO_SUBAGENT_ROSTER: StructuredAgentSubagentRoster = new Map()

export function useStructuredAgentSessionTransportState(
  state: StructuredAgentSessionState,
  enabled: boolean
) {
  const journalItems = enabled ? state.items : NO_JOURNAL_ITEMS
  const submissions = enabled ? state.submissions : NO_SUBMISSIONS
  const subagentRoster = (enabled ? state.subagentRoster : undefined) ?? NO_SUBAGENT_ROSTER
  const fence = enabled ? state.fence : null
  const turnId = activeStructuredAgentSessionTurnId(journalItems)
  // The rule the host projects every session list's Working from, so this chat cannot disagree.
  const isWorking = isStructuredAgentSessionMainAgentWorking(turnId, submissions, fence)
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
    subagentRoster,
    submissions,
    fence,
    turnId,
    isWorking,
    turnActivity,
    turnTiming,
    // null = no drafts or no claim; the projection treats both as an empty list.
    queuedMessages: (enabled ? state.queuedMessages : null) ?? null,
    queuePause: (enabled ? state.queuePause : null) ?? null,
    /** Absent from older hosts (and while disabled): the card then shows nothing. */
    asyncQuestions:
      (enabled ? state.asyncQuestions : undefined) ?? NATIVE_CHAT_ASYNC_QUESTIONS_ABSENT,
    backgroundTasks: structuredSessionBackgroundTasksView(
      enabled ? state.backgroundTasks : null,
      turnId
    )
  }
}
