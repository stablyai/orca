import { useMemo } from 'react'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat-turn-activity'
import {
  nativeChatReasoningGate,
  nativeChatReasoningGateKey
} from '../../../../shared/native-chat-reasoning-row'
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
  const activity = enabled ? state.activity : null
  const turnActivity = useMemo(
    () => selectStructuredAgentTurnActivity(journalItems, turnId, activity),
    [activity, journalItems, turnId]
  )
  // Keyed on what it answers, not on the frame: activity text changes must not rebuild the transcript.
  const reasoningKey = nativeChatReasoningGateKey(activity, turnId)
  const isReasoningOpen = useMemo(() => nativeChatReasoningGate(reasoningKey), [reasoningKey])
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
    isReasoningOpen,
    turnTiming,
    // null = no drafts or no claim; the projection treats both as an empty list.
    queuedMessages: (enabled ? state.queuedMessages : null) ?? null,
    queuePause: (enabled ? state.queuePause : null) ?? null,
    backgroundTasks: structuredSessionBackgroundTasksView(
      enabled ? state.backgroundTasks : null,
      turnId
    )
  }
}
