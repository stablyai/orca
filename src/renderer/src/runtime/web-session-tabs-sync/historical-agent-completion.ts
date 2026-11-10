import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion/agent-completion-coordinator-types'
import { completionHistoryContains } from '../../../../shared/agent-status/lifecycle/agent-completion-history'
import { agentTurnEndedOnPurpose } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'

/** A real saved end can catch up; the passive sleep presentation itself is never an end. */
export function historicalAgentCompletion(
  row: AgentStatusEntry,
  previous: AgentStatusEntry | undefined,
  acknowledgement: number | undefined,
  clearedAt: number | undefined,
  liveFrame: boolean
): {
  payload: AgentCompletionStatusSnapshot & { stateStartedAt: number }
  seedOnly?: true
  fromHistory: true
} | null {
  if (!row.sessionBoundary || row.restoredUnconfirmed) {
    return null
  }
  const end = row.stateHistory.findLast(
    (entry) => entry.state === 'done' && !agentTurnEndedOnPurpose(entry)
  )
  if (!end) {
    return null
  }
  const payload: AgentCompletionStatusSnapshot & { stateStartedAt: number } = {
    state: 'done',
    prompt: end.prompt,
    agentType: row.agentType,
    stateStartedAt: end.startedAt,
    turnEndedAt: end.turnEndedAt,
    turnEndDisposition: end.turnEndDisposition,
    turnCompletedAt: end.turnCompletedAt,
    lastAssistantMessage: row.lastCompletedAssistantMessage,
    interrupted: end.interrupted,
    mainAgent: end.mainAgent
  }
  const alreadySeen =
    previous &&
    (completionHistoryContains(previous, payload) ||
      (previous.state === 'done' &&
        !previous.sessionBoundary &&
        previous.stateStartedAt === end.startedAt &&
        previous.turnEndedAt === end.turnEndedAt))
  const read = Math.max(acknowledgement ?? 0, clearedAt ?? 0) >= end.startedAt
  const notify = !alreadySeen && !read && (liveFrame || previous !== undefined)
  return { payload, fromHistory: true, ...(!notify ? { seedOnly: true as const } : {}) }
}
