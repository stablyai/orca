import { useMemo } from 'react'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking
} from '../../../../shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { structuredSessionBackgroundTasksView } from '../../../../shared/structured-session-background-tasks-view'
import { structuredSessionForegroundCommands } from '../../../../shared/structured-session-foreground-commands'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'
import { agentSessionCurrentContextRows } from '../../../../shared/agent-session-context-clear'

const NO_JOURNAL_ITEMS: StructuredAgentSessionState['items'] = []
const NO_SUBMISSIONS: StructuredAgentSessionState['submissions'] = []
const NO_SUBAGENT_ROSTER: StructuredAgentSubagentRoster = new Map()

/** The host's prompts still waiting on the person and its working answer; empty from an older
 *  host, whose readers derive both from the rows. */
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
  // The host's answer to which pending prompts still wait on the person; absent from an older host.
  const actionablePromptIds = enabled ? state.actionablePromptIds : undefined
  const current = useMemo(
    () => agentSessionCurrentContextRows(journalItems, submissions),
    [journalItems, submissions]
  )
  // The host's whole-journal turn, never the loaded rows': a long turn's record is off the page.
  const turnId = runningStructuredAgentSessionTurnId({ items: journalItems, latestTurn })
  // The host's own answer, which counts only the agent running now; an older host gives none, and
  // the rule it projects every session list's Working from stands in, so this chat cannot disagree.
  const hostWorking = enabled ? state.working : undefined
  const isWorking = structuredAgentSessionHostSaysWorking(hostWorking, () =>
    isStructuredAgentSessionMainAgentWorking(turnId, current.submissions, fence)
  )
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
