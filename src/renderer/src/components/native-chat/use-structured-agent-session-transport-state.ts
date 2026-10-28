import { useMemo } from 'react'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking,
  structuredAgentSessionQueueSendsNext
} from '../../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat/transcript/native-chat-turn-activity'
import { structuredSessionBackgroundTasksView } from '../../../../shared/structured-session-background-tasks-view'
import { structuredSessionForegroundCommands } from '../../../../shared/structured-session-foreground-commands'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'
import { agentSessionCurrentContextRows } from '../../../../shared/agent-session-context-clear'

const NO_JOURNAL_ITEMS: StructuredAgentSessionState['items'] = []
const NO_SUBMISSIONS: StructuredAgentSessionState['submissions'] = []
const NO_SUBAGENT_ROSTER: StructuredAgentSubagentRoster = new Map()

/** Host prompt/working evidence; older hosts omit it and readers derive state from journal rows. */
export type StructuredAgentSessionHostWork = {
  actionablePromptIds?: readonly string[]
  working?: boolean
}

export function useStructuredAgentSessionTransportState(
  state: StructuredAgentSessionState,
  enabled: boolean
) {
  const journalItems = enabled ? state.items : NO_JOURNAL_ITEMS
  const submissions = enabled ? state.submissions : NO_SUBMISSIONS
  const subagentRoster = (enabled ? state.subagentRoster : undefined) ?? NO_SUBAGENT_ROSTER
  const fence = enabled ? state.fence : null
  const latestTurn = enabled ? state.latestTurn : undefined
  const actionablePromptIds = enabled ? state.actionablePromptIds : undefined
  const current = useMemo(
    () => agentSessionCurrentContextRows(journalItems, submissions),
    [journalItems, submissions]
  )
  // A long turn’s record may be off-page; prefer the host’s whole-journal answer.
  const turnId = runningStructuredAgentSessionTurnId({ items: journalItems, latestTurn })
  // Prefer current-provider host evidence; older hosts use the same projection as session lists so chat and sidebar agree.
  const hostWorking = enabled ? state.working : undefined
  const isWorking = structuredAgentSessionHostSaysWorking(hostWorking, () =>
    isStructuredAgentSessionMainAgentWorking(turnId, current.submissions, fence)
  )
  const queueSendsNext = structuredAgentSessionQueueSendsNext(
    enabled ? state.nextQueuedMessageId : null,
    isWorking
  )
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
  const backgroundTasks = useMemo(() => {
    const roster = enabled ? state.backgroundTasks : null
    return structuredSessionBackgroundTasksView(
      roster,
      turnId,
      structuredSessionForegroundCommands(roster, { items: journalItems, latestTurn })
    )
  }, [enabled, journalItems, latestTurn, state.backgroundTasks, turnId])
  const hostWork = useMemo<StructuredAgentSessionHostWork>(
    () => ({
      ...(actionablePromptIds ? { actionablePromptIds } : {}),
      ...(hostWorking !== undefined ? { working: hostWorking } : {})
    }),
    [actionablePromptIds, hostWorking]
  )
  return {
    journalItems,
    currentRequests: enabled ? state.currentRequests : undefined,
    latestTurn,
    actionablePromptIds,
    hostWork,
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
    backgroundTasks,
    conversationBusy: Boolean(turnId || backgroundTasks.isMonitoring)
  }
}
