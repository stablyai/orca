import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { selectWorkerTabFold, forgetWorkerTabFolding } from './worker-tab-folding'
import { selectCoordinatorNeedsYouCount } from './worker-tab-presentation'

// Each worker tab holds only the leaf Orca created for it, so it folds.
const workerLayout = {
  root: { type: 'leaf' as const, leafId: '00000000-0000-4000-8000-000000000001' },
  activeLeafId: null,
  expandedLeafId: null
}

vi.mock('@/components/sidebar/workspace-card/activity/worktree-agent-rows-projection', () => {
  const rows: never[] = []
  return { getSharedWorktreeAgentRowsSelector: () => () => rows }
})

it.each(['last worker removed', 'alternating workspaces'] as const)(
  'does not retain obsolete store snapshots or drafts after %s',
  async (scenario) => {
    const base = useAppStore.getState()
    const groups = {
      wt: [makeTabGroup({ id: 'pane-a', worktreeId: 'wt', activeTabId: 'ordinary' })],
      other: [makeTabGroup({ id: 'pane-b', worktreeId: 'other', activeTabId: 'ordinary' })]
    }
    const worker = (worktreeId: string, groupId: string) =>
      makeUnifiedTab({
        id: `worker-${worktreeId}`,
        worktreeId,
        groupId,
        workerTab: {
          origin: {
            runId: 'run',
            dispatchId: `dispatch-${worktreeId}`,
            taskId: `task-${worktreeId}`,
            workerLeafId: '00000000-0000-4000-8000-000000000001',
            parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
            coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
          }
        }
      })
    const tabs = { wt: [worker('wt', 'pane-a')], other: [worker('other', 'pane-b')] }
    const snapshots: WeakRef<AppState>[] = []
    const drafts: WeakRef<AppState['editorDrafts']>[] = []
    const visit = (worktreeId: 'wt' | 'other', remove = false) => {
      const state: AppState = {
        ...base,
        activeWorktreeId: worktreeId,
        groupsByWorktree: groups,
        unifiedTabsByWorktree: remove ? { ...tabs, wt: [] } : tabs,
        editorDrafts: { editor: `Unsaved ${worktreeId} text` },
        workerTabsMode: 'open-when-clicked',
        workerTabPeekByGroupId: {},
        workerTabStripChoiceByWorktree: {},
        workerTabFailOpenShown: {},
        terminalLayoutsByTabId: { 'worker-wt': workerLayout, 'worker-other': workerLayout }
      }
      selectWorkerTabFold(state, worktreeId, worktreeId === 'wt' ? 'pane-a' : 'pane-b')
      selectCoordinatorNeedsYouCount(state, 'ordinary')
      snapshots.push(new WeakRef(state))
      drafts.push(new WeakRef(state.editorDrafts))
    }
    visit('wt')
    if (scenario === 'last worker removed') {
      visit('wt', true)
    } else {
      visit('other')
      visit('wt')
    }
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    try {
      for (let round = 0; round < 3; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect(snapshots.every((reference) => reference.deref() === undefined)).toBe(true)
      expect(drafts.every((reference) => reference.deref() === undefined)).toBe(true)
    } finally {
      forgetWorkerTabFolding('wt')
      forgetWorkerTabFolding('other')
    }
  }
)

it('releases closed pane snapshots and unsaved drafts while the workspace stays open', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(100_000)
  const base = useAppStore.getState()
  const stateFor = (groupId: string): AppState => ({
    ...base,
    groupsByWorktree: {
      wt: [makeTabGroup({ id: groupId, worktreeId: 'wt', activeTabId: 'ordinary' })]
    },
    unifiedTabsByWorktree: {
      wt: [
        makeUnifiedTab({
          id: 'worker',
          groupId,
          worktreeId: 'wt',
          createdAt: 100_000,
          workerTab: {
            origin: {
              runId: 'run',
              dispatchId: 'dispatch',
              taskId: 'task',
              workerLeafId: '00000000-0000-4000-8000-000000000001',
              parent: { kind: 'pane', paneKey: 'coordinator:leaf' },
              coordinator: { kind: 'pane', paneKey: 'coordinator:leaf' }
            }
          }
        })
      ]
    },
    editorDrafts: { editor: `Unsaved text in ${groupId}` },
    workerTabsMode: 'open-when-clicked',
    workerTabPeekByGroupId: {},
    workerTabStripChoiceByWorktree: {},
    workerTabFailOpenShown: {},
    terminalLayoutsByTabId: { worker: workerLayout }
  })
  const closed: WeakRef<AppState>[] = []
  const drafts: WeakRef<AppState['editorDrafts']>[] = []
  const visitPane = (index: number) => {
    const state = stateFor(`closed-${index}`)
    selectWorkerTabFold(state, 'wt', `closed-${index}`)
    closed.push(new WeakRef(state))
    drafts.push(new WeakRef(state.editorDrafts))
  }
  for (let index = 0; index < 32; index++) {
    visitPane(index)
  }
  const surviving = stateFor('surviving')
  selectWorkerTabFold(surviving, 'wt', 'surviving')
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  try {
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(closed.every((ref) => ref.deref() === undefined)).toBe(true)
    expect(drafts.every((ref) => ref.deref() === undefined)).toBe(true)
    expect(selectWorkerTabFold(surviving, 'wt', 'surviving').folded.has('worker')).toBe(true)
  } finally {
    forgetWorkerTabFolding('wt')
    vi.useRealTimers()
  }
})
