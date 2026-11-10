import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type { AgentStateHistoryEntry } from '../../agent-status/lifecycle/agent-state-history'

export type RealCompletionHistoryEntry = AgentStateHistoryEntry & { state: 'done' }
export type PreviousPaneCompletion = {
  kind: 'previous'
  end: RealCompletionHistoryEntry
  lastAssistantMessage?: string
  lastAssistantMessageIsToolOutput?: boolean
}
export type PaneAgentCompletion =
  | { kind: 'passive' }
  | { kind: 'current'; turnCompletedAt?: number }
  | PreviousPaneCompletion

type Source = Pick<AgentStatusEntry, 'state' | 'prompt' | 'updatedAt'> &
  Partial<AgentStatusEntry> & {
    turnCompletedAt?: number
    previousCompletion?: PreviousPaneCompletion
    isReplay?: boolean
    providerSessionOnly?: boolean
  }

export function previousPaneCompletion(entry: Source): PreviousPaneCompletion | undefined {
  if (
    entry.state !== 'done' ||
    entry.sessionBoundary ||
    entry.isReplay ||
    entry.restoredUnconfirmed ||
    entry.providerSessionOnly
  ) {
    return entry.previousCompletion
  }
  if (entry.stateStartedAt === undefined) {
    return entry.previousCompletion
  }
  return {
    kind: 'previous',
    end: {
      state: 'done',
      prompt: entry.prompt,
      startedAt: entry.stateStartedAt,
      observedAt: entry.stateObservedAt,
      turnStartedAt: entry.turnStartedAt,
      turnEndedAt: entry.turnEndedAt,
      turnEndDisposition: entry.turnEndDisposition,
      turnCompletedAt: entry.turnCompletedAt,
      interrupted: entry.interrupted,
      mainAgent: entry.mainAgent
    },
    lastAssistantMessage: entry.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput
  }
}

/** Capture accepted completion meaning before sleep changes presentation or resume policy. */
export function paneAgentCompletion(entry: Source): PaneAgentCompletion {
  const current = previousPaneCompletion({ ...entry, previousCompletion: undefined })
  if (current) {
    return {
      kind: 'current',
      ...(entry.turnCompletedAt !== undefined ? { turnCompletedAt: entry.turnCompletedAt } : {})
    }
  }
  if (entry.previousCompletion) {
    return entry.previousCompletion
  }
  const end = entry.stateHistory?.findLast((state) => state.state === 'done')
  return end?.state === 'done'
    ? {
        kind: 'previous',
        end: { ...end, state: 'done' },
        lastAssistantMessage: entry.lastCompletedAssistantMessage
      }
    : { kind: 'passive' }
}
