import { expect, it } from 'vitest'
import type { WorkerTabStamp } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { admitBulkWorkerClose } from './worker-tab-close-target'

// WT-D3C-07 (item 1237): every unresolved address used to scan every legacy row.
it('visits each legacy address once when admitting a bulk close', () => {
  const stamp: WorkerTabStamp = {
    origin: {
      runId: 'run',
      dispatchId: 'dispatch',
      taskId: 'task',
      parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
      coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
    }
  }
  let visits = 0
  const rows = Array.from({ length: 2048 }, (_, index): TerminalTab => ({
    get id() {
      visits++
      return `legacy-${index}`
    },
    worktreeId: 'wt',
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 1,
    workerTab: stamp
  }))
  const targets = Array.from({ length: 256 }, (_, index) => `unresolved-${index}`)
  const kept = admitBulkWorkerClose(
    { tabsByWorktree: { wt: rows }, unifiedTabsByWorktree: {}, terminalLayoutsByTabId: {} },
    [...targets, 'legacy-2047']
  )
  expect([...kept]).toEqual(['legacy-2047'])
  expect(visits).toBeLessThanOrEqual(2048)
})
