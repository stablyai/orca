import { defineFixture } from '../../component-fixtures/component-fixture'
import { renderResourceUsageSummary } from './resource-usage-popover-summary'
import { ResourceUsageStatusSegment } from './ResourceUsageStatusSegment'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import {
  getResourceMemoryMetricCopy,
  getResourceCommitMetricCopy
} from './resource-memory-metric-copy'

export const metricDetails = defineFixture({
  width: 420,
  render: () =>
    renderResourceUsageSummary({
      totalCpu: 138,
      totalMemory: 2147483648,
      memoryMetricCopy: getResourceMemoryMetricCopy('working-set'),
      commitBadgeLabel: '3 GB',
      commitMetricCopy: getResourceCommitMetricCopy(),
      commitToneClass: null,
      orphanCount: 0
    }),
  interact: (frame) => {
    frame.querySelector('summary')?.click()
  }
})

export const narrowMetricDetails = defineFixture({ ...metricDetails, width: 280 })

export const orphanSummary = defineFixture({
  width: 420,
  render: () =>
    renderResourceUsageSummary({
      totalCpu: 138,
      totalMemory: 2147483648,
      memoryMetricCopy: getResourceMemoryMetricCopy('footprint'),
      commitBadgeLabel: null,
      commitMetricCopy: null,
      commitToneClass: null,
      orphanCount: 2
    })
})

const windowsSnapshot: MemorySnapshot = {
  app: {
    cpu: 138,
    memory: 2147483648,
    main: { cpu: 38, memory: 536870912 },
    renderer: { cpu: 100, memory: 1610612736 },
    other: { cpu: 0, memory: 0 },
    history: []
  },
  worktrees: [],
  host: {
    totalMemory: 17179869184,
    freeMemory: 8589934592,
    availableMemory: 8589934592,
    availableMemorySource: 'free-memory',
    usedMemory: 8589934592,
    memoryUsagePercent: 50,
    cpuCoreCount: 8,
    loadAverage1m: 0
  },
  processMemoryMetric: 'working-set',
  processCommitMetric: 'private-bytes',
  totalCpu: 138,
  totalMemory: 2147483648,
  totalPrivateMemory: 3221225472,
  collectedAt: 1
}

const crowdedSnapshot: MemorySnapshot = {
  ...windowsSnapshot,
  worktrees: Array.from({ length: 15 }, (_, index) => ({
    worktreeId: `workspace-${index + 1}`,
    worktreeName: `Workspace ${index + 1}`,
    repoId: 'fixture-project',
    repoName: 'Project',
    cpu: 0,
    memory: 0,
    sessions: [],
    history: []
  }))
}

export const shortWindowMetricDetails = defineFixture({
  width: 440,
  store: { memorySnapshot: crowdedSnapshot, workspaceSessionReady: true },
  setup: () => {
    window.api.memory.getSnapshot = async () => crowdedSnapshot
    window.api.pty.listSessions = async () => []
  },
  render: () => (
    <div className="flex h-90 items-end justify-end">
      <ResourceUsageStatusSegment iconOnly={false} />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button')?.click()
    await new Promise(requestAnimationFrame)
    const popover = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
    if (popover) {
      popover.style.maxHeight = '320px'
    }
    popover?.querySelector('summary')?.click()
  }
})

export const shortWindowCollapsedDetails = defineFixture({
  ...shortWindowMetricDetails,
  interact: async (frame) => {
    await shortWindowMetricDetails.interact?.(frame)
    document.querySelector('[data-slot="popover-content"] details')?.removeAttribute('open')
  }
})

export const shortWindowOrphanCleanup = defineFixture({
  ...shortWindowMetricDetails,
  setup: () => {
    shortWindowMetricDetails.setup?.()
    window.api.pty.listSessions = async () => [
      { id: 'fixture-orphan', cwd: '/workspace', title: 'Terminal', agentOwnership: 'absent' }
    ]
  }
})
