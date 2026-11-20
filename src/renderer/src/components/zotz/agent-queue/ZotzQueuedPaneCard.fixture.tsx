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
    perAgentMaxBytes: 5.6 * GB,
    sampledAt: 0
  },
  running: [
    {
      paneKey: 'a',
      agent: 'claude',
      state: 'working',
      worktreeId: null,
      bytes: 2.4 * GB,
      peakBytes: 2.6 * GB,
      startedAt: 0
    },
    {
      paneKey: 'b',
      agent: 'codex',
      state: 'working',
      worktreeId: null,
      bytes: 2.8 * GB,
      peakBytes: 2.8 * GB,
      startedAt: 0
    }
  ],
  done: [],
  canceled: [],
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
  enqueuedAt: Date.now() - 20 * 60_000,
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

export const thirdUnderPressure = defineFixture({
  width: 520,
  render: () => (
    <ZotzQueuedPaneCard
      task={task(3, 'pressure')}
      snapshot={SNAPSHOT}
      onCancel={() => {}}
      onForceStart={() => {}}
    />
  )
})

/** A chat whose agent runs on another machine: its wait shows, but this window has no buttons for it. */
export const waitingOnAnotherMachine = defineFixture({
  width: 520,
  render: () => (
    <ZotzQueuedPaneCard task={task(1, 'pressure')} snapshot={SNAPSHOT} hostLabel="MSI Server" />
  )
})

/** The same wait on a server that also lets this window cancel it or launch anyway. */
export const waitingOnAnotherMachineWithControls = defineFixture({
  width: 520,
  render: () => (
    <ZotzQueuedPaneCard
      task={task(1, 'pressure')}
      snapshot={SNAPSHOT}
      hostLabel="MSI Server"
      onCancel={() => {}}
      onForceStart={() => {}}
    />
  )
})
