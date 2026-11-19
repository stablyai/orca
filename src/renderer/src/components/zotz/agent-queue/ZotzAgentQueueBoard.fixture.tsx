import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ZotzAgentQueueBoard } from './ZotzAgentQueueBoard'

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

export const busyEvening = defineFixture({
  width: 1000,
  render: () => (
    <ZotzAgentQueueBoard
      snapshot={SNAPSHOT}
      now={NOW}
      workspaceName={(id) => id ?? ''}
      onForceStart={() => {}}
      onCancel={() => {}}
      onOpenPane={() => {}}
    />
  )
})
