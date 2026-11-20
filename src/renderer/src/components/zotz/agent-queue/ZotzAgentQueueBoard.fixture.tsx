import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ZotzAgentQueueBoard, type ZotzAgentQueueMachine } from './ZotzAgentQueueBoard'

const GB = 1024 ** 3
const MIN = 60_000
const NOW = 100 * MIN

// The MSI on a busy evening: two agents working, one waiting on Hugo, four in line.
const SNAPSHOT: ZotzAgentQueueSnapshot = {
  memory: {
    totalBytes: 16 * GB,
    availableBytes: 5.2 * GB,
    pressure: 'ok',
    minFreeBytes: 2.4 * GB,
    perAgentMaxBytes: 5.6 * GB,
    sampledAt: NOW
  },
  running: [
    {
      paneKey: 'p1',
      agent: 'claude',
      state: 'working',
      worktreeId: 'refactor-auth',
      bytes: 2.4 * GB,
      peakBytes: 2.6 * GB,
      startedAt: NOW - 41 * MIN
    },
    {
      paneKey: 'p2',
      agent: 'codex',
      state: 'working',
      worktreeId: 'fix-ci',
      bytes: 5.2 * GB,
      peakBytes: 5.2 * GB,
      startedAt: NOW - 9 * MIN
    },
    {
      paneKey: 'p3',
      agent: 'claude',
      state: 'done',
      worktreeId: 'docs-remote',
      bytes: 1.1 * GB,
      peakBytes: 3.2 * GB,
      startedAt: NOW - 60 * MIN
    }
  ],
  done: [
    {
      paneKey: 'p4',
      agent: 'codex',
      worktreeId: 'lint',
      peakBytes: 2 * GB,
      startedAt: NOW - 90 * MIN,
      endedAt: NOW - 75 * MIN
    },
    {
      paneKey: 'p5',
      agent: 'antigravity',
      worktreeId: 'landing-copy',
      peakBytes: 1.6 * GB,
      startedAt: NOW - 70 * MIN,
      endedAt: NOW - 48 * MIN
    }
  ],
  canceled: [],
  queued: [
    {
      id: 'q1',
      agent: 'claude',
      priority: 'manual',
      label: 'zotz-docs',
      estimatedBytes: 1.4 * GB,
      enqueuedAt: NOW - 2 * MIN,
      position: 1,
      waitReason: 'memory'
    },
    {
      id: 'q2',
      agent: 'codex',
      priority: 'remote',
      label: 'api-pagos',
      estimatedBytes: 3 * GB,
      enqueuedAt: NOW - 4 * MIN,
      position: 2,
      waitReason: 'memory'
    },
    {
      id: 'q3',
      agent: 'claude',
      priority: 'automation',
      label: 'nightly-tests',
      estimatedBytes: 2.5 * GB,
      enqueuedAt: NOW - 30 * MIN,
      position: 3,
      waitReason: 'memory'
    },
    {
      id: 'q4',
      agent: 'antigravity',
      priority: 'automation',
      label: 'landing',
      estimatedBytes: 1.8 * GB,
      enqueuedAt: NOW - 31 * MIN,
      position: 4,
      waitReason: 'memory'
    }
  ]
}

const actions = { onCancel: () => {}, onForceStart: () => {} }

const MSI: ZotzAgentQueueMachine = {
  hostId: 'runtime:msi',
  name: 'MSI Server',
  isThisDevice: false,
  snapshot: SNAPSHOT,
  ...actions
}

// The Mac with one agent working and one waiting on Hugo.
const LAPTOP: ZotzAgentQueueMachine = {
  hostId: 'local',
  name: 'Local Mac',
  isThisDevice: true,
  snapshot: {
    memory: {
      totalBytes: 24 * GB,
      availableBytes: 12.5 * GB,
      pressure: 'ok',
      minFreeBytes: 3.6 * GB,
      perAgentMaxBytes: 6 * GB,
      sampledAt: NOW
    },
    running: [
      { ...SNAPSHOT.running[0], paneKey: 'mac-1', worktreeId: 'zotz-cola' },
      { ...SNAPSHOT.running[2], paneKey: 'mac-2', worktreeId: 'zotz-chat' }
    ],
    done: [],
    canceled: [],
    queued: [{ ...SNAPSHOT.queued[0], id: 'mac-q1', label: 'zotz-docs', position: 1 }]
  },
  ...actions
}

function board(machines: ZotzAgentQueueMachine[]): React.JSX.Element {
  return (
    <ZotzAgentQueueBoard
      machines={machines}
      now={NOW}
      workspaceName={(id) => id ?? ''}
      onOpenPane={() => {}}
    />
  )
}

export const busyEvening = defineFixture({
  width: 1000,
  render: () => board([{ ...MSI, isThisDevice: true, hostId: 'local' }])
})

export const machines = defineFixture({ width: 1100, render: () => board([LAPTOP, MSI]) })

export const machinesReadOnlyServer = defineFixture({
  width: 1100,
  render: () => board([LAPTOP, { ...MSI, onCancel: undefined, onForceStart: undefined }])
})
