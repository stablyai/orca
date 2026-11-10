import type { AgentStateHistoryEntry } from './agent-state-history'
import type { AgentStatusEntry } from '../contracts/agent-status-types'

/** Exact real completion membership; a later passive display does not supersede its own history. */
export function completionHistoryContains(
  entry: Pick<AgentStatusEntry, 'stateHistory'>,
  completion: {
    stateStartedAt?: number
    prompt?: string
    turnEndedAt?: number
    turnCompletedAt?: number
  }
): boolean {
  return entry.stateHistory.some((end) => completionHistoryEndMatches(end, completion))
}

export function completionHistoryEndMatches(
  end: AgentStateHistoryEntry,
  completion: {
    stateStartedAt?: number
    prompt?: string
    turnEndedAt?: number
    turnCompletedAt?: number
  }
): boolean {
  return (
    end.state === 'done' &&
    end.startedAt === completion.stateStartedAt &&
    end.prompt === completion.prompt &&
    end.turnEndedAt === completion.turnEndedAt &&
    end.turnCompletedAt === completion.turnCompletedAt
  )
}
