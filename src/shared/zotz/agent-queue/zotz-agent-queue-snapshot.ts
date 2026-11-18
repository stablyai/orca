import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import type { AgentStatusState } from '../../agent-status/contracts/agent-status-types'
import type { ZotzAgentTaskPriority } from './zotz-agent-queue'
import type { ZotzAgentWaitReason } from './zotz-agent-queue-scheduler'
import type { ZotzMemoryPressure } from './zotz-memory-pressure'

/** What the window shows about memory and the agent queue: pane overlays and the queue board. */
export type ZotzAgentQueueSnapshot = {
  memory: {
    totalBytes: number
    availableBytes: number
    pressure: ZotzMemoryPressure
    minFreeBytes: number
    agentBudgetBytes: number
    perAgentMaxBytes: number
    maxConcurrentAgents: number
    sampledAt: number
  } | null
  /** Agents with a live terminal; `state` splits In Progress (working) from Review (waiting on you). */
  running: {
    paneKey: string
    agent: TuiAgent
    state: AgentStatusState
    worktreeId: string | null
    bytes: number
    peakBytes: number
    startedAt: number
  }[]
  /** The latest runs whose terminal closed, newest first. */
  done: {
    paneKey: string
    agent: TuiAgent
    worktreeId: string | null
    peakBytes: number
    startedAt: number
    endedAt: number
  }[]
  /** The backlog in service order; position 1 is the next to start. */
  queued: {
    id: string
    agent: TuiAgent
    priority: ZotzAgentTaskPriority
    label: string
    estimatedBytes: number
    enqueuedAt: number
    position: number
    waitReason: ZotzAgentWaitReason | 'pressure' | null
  }[]
  /** Launches the user canceled; their panes stay as plain shells with a "canceled" mark. */
  canceled: {
    id: string
    agent: TuiAgent
    /** The workspace the pane belongs to, when known. */
    label: string
    canceledAt: number
  }[]
}

export const EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT: ZotzAgentQueueSnapshot = {
  memory: null,
  running: [],
  done: [],
  queued: [],
  canceled: []
}
