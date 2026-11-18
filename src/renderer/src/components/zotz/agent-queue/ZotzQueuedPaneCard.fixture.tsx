import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ZotzQueuedPaneCard } from './ZotzQueuedPanePortals'

const GB = 1024 ** 3

const SNAPSHOT: ZotzAgentQueueSnapshot = {
  memory: {
    totalBytes: 16 * GB,
    availableBytes: 3.1 * GB,
    pressure: 'ok',
    minFreeBytes: 2.4 * GB,
    agentBudgetBytes: 11.2 * GB,
    perAgentMaxBytes: 5.6 * GB,
    maxConcurrentAgents: 2,
    sampledAt: 0
  },
  running: [
    { paneKey: 'a', agent: 'claude', bytes: 2.4 * GB, peakBytes: 2.6 * GB, startedAt: 0 },
    { paneKey: 'b', agent: 'codex', bytes: 2.8 * GB, peakBytes: 2.8 * GB, startedAt: 0 }
  ],
  queued: []
}

const task = (
  position: number,
  waitReason: ZotzAgentQueueSnapshot['queued'][number]['waitReason']
) => ({
  id: `pane-${position}`,
  agent: 'claude' as const,
  priority: 'manual' as const,
  label: 'zotz-docs',
  estimatedBytes: 3.1 * GB,
  enqueuedAt: 0,
  position,
  waitReason
})

export const nextWaitingForMemory = defineFixture({
  width: 520,
  render: () => (
    <ZotzQueuedPaneCard
      task={task(1, 'memory')}
      snapshot={SNAPSHOT}
      onCancel={() => {}}
      onForceStart={() => {}}
    />
  )
})

export const thirdWaitingForSlot = defineFixture({
  width: 520,
  render: () => (
    <ZotzQueuedPaneCard
      task={task(3, 'concurrency')}
      snapshot={SNAPSHOT}
      onCancel={() => {}}
      onForceStart={() => {}}
    />
  )
})
