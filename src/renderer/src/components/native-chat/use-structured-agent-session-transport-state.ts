import { useMemo } from 'react'
import { runningStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-live-turn'
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
  const latestTurn = enabled ? state.latestTurn : undefined
  // The host's whole-journal turn, never the loaded rows': a long turn's record is off the page.
  const turnId = runningStructuredAgentSessionTurnId({ items: journalItems, latestTurn })
  // The rule the host projects every session list's Working from, so this chat cannot disagree.
  const isWorking = isStructuredAgentSessionMainAgentWorking(turnId, submissions, fence)
  const nextQueuedMessageId = (enabled ? state.nextQueuedMessageId : null) ?? null
  // The host names the card its queue sends next. That send lands in a later update than a turn's
  // end or a Resume, so until then the chat still reads as working and nothing flips in between.
  const queueSendsNext = nextQueuedMessageId !== null && !isWorking
  const turnActivity = useMemo(
    () => selectStructuredAgentTurnActivity(journalItems, turnId, enabled ? state.activity : null),
    [enabled, journalItems, state.activity, turnId]
  )
  const turnTiming = useStructuredAgentTurnTiming(
    {
      items: journalItems,
      submissions,
      latestTurn,
      ...(enabled ? { hostClock: state.hostClock } : {})
    },
    turnId
  )
  return {
    journalItems,
    latestTurn,
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
    /** Working only because the queue is about to send: nothing is in flight to stop yet. */
    queueSendsNext,
    backgroundTasks: structuredSessionBackgroundTasksView(
      enabled ? state.backgroundTasks : null,
      turnId
    )
  }
}
