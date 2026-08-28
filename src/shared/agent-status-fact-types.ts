import type { AgentStatusEntry } from './agent-status-types'

/** Capability advertised by hosts that retain ordered agent-status facts. */
export const AGENT_STATUS_FACT_STREAM_RUNTIME_CAPABILITY = 'agent-status.fact-stream.v1' as const

export type AgentStatusFact = {
  seq: number
  epoch: string
  paneKey: string
  worktreeId: string
  /** Null is a pane teardown tombstone; it must never raise attention. */
  status: AgentStatusEntry | null
  /** Event-only turn identity used while Claude remains in `working`. */
  turnCompletedAt?: number
}

export type AgentStatusFactStreamMessage =
  | {
      type: 'ready'
      subscriptionId: string
      epoch: string
      headSeq: number
      gap: boolean
    }
  | { type: 'fact'; fact: AgentStatusFact }
  | { type: 'end' }

export type AgentStatusFactInput = Omit<AgentStatusFact, 'seq' | 'epoch'>
