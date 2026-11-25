import { expect, it } from 'vitest'
import { tabBucketDraft } from '@/store/record-transitions/keyed-record-transitions'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type { WorkerTabStamp } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  admitBulkWorkerClose,
  resolveWorkerCloseTarget,
  workerCloseKindOf
} from './worker-tab-close-target'

const stamp: WorkerTabStamp = {
  origin: {
    runId: 'run',
    dispatchId: 'dispatch',
    taskId: 'task',
    parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
    coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
  }
}

function legacyRow(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt',
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

// WT-D3C-07 (item 1237): every unresolved address used to scan every legacy row.
it('visits each legacy address once when admitting a bulk close', () => {
  let visits = 0
  const rows = Array.from({ length: 2048 }, (_, index): TerminalTab => ({
    ...legacyRow(`legacy-${index}`),
    get id() {
      visits++
      return `legacy-${index}`
    },
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

it('uses row changes across ordinary closes and sees a newly stamped collision', () => {
  let visits = 0
  const rows = Array.from({ length: 2048 }, (_, index): TerminalTab => ({
    ...legacyRow(`legacy-${index}`),
    get workerTab() {
      visits++
      return undefined
    }
  }))
  const state: Parameters<typeof admitBulkWorkerClose>[0] = {
    tabsByWorktree: { wt: rows },
    unifiedTabsByWorktree: {
      wt: rows.map(({ id }) => makeUnifiedTab({ id, worktreeId: 'wt', groupId: 'pane' }))
    },
    terminalLayoutsByTabId: {}
  }
  const publishLegacy = (remaining: TerminalTab[]) => {
    const draft = tabBucketDraft(state.tabsByWorktree)
    draft.set('wt', remaining)
    state.tabsByWorktree = draft.finish()
  }
  const targets = Array.from({ length: 256 }, (_, index) => `legacy-${index}`)
  expect(admitBulkWorkerClose(state, targets).size).toBe(0)
  for (const [index, id] of targets.entries()) {
    expect(workerCloseKindOf(state, resolveWorkerCloseTarget(state, id))).toBe('none')
    publishLegacy(rows.slice(index + 1))
  }
  expect(visits).toBeLessThanOrEqual(2048)

  publishLegacy([{ ...legacyRow('legacy-256'), workerTab: stamp }, ...rows.slice(257)])
  expect(workerCloseKindOf(state, resolveWorkerCloseTarget(state, 'legacy-256'))).toBe('mixed')
})
