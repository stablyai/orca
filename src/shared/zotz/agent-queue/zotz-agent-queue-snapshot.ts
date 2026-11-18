import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
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
  running: {
    paneKey: string
    agent: TuiAgent
    bytes: number
    peakBytes: number
    startedAt: number
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
}

export const EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT: ZotzAgentQueueSnapshot = {
  memory: null,
  running: [],
  queued: []
}
