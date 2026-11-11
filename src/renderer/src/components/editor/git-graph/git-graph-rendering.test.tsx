import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitGraphTab } from './git-graph-tab'

import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

const { getHistory, getRefs, viewport } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getRefs: vi.fn(),
  viewport: { rows: 20, rendered: Infinity }
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory,
  getRuntimeGitRefs: getRefs
}))
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitCommitCompare: vi.fn(async () => ({ summary: { status: 'ready' }, entries: [] }))
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getScrollElement: () => HTMLElement | null }) => ({
    getTotalSize: () => options.count * 28,
    getVirtualItems: () =>
      Array.from({ length: Math.min(options.count, viewport.rendered) }, (_, index) => ({
        index,
        start: index * 28
      })),
    get range() {
      return options.count
        ? { startIndex: 0, endIndex: Math.min(options.count, viewport.rows) - 1 }
        : null
    },
    measureElement: () => {},
    scrollToIndex: (index: number) => {
      const element = options.getScrollElement()
      if (element) {
        element.scrollTop = index * 28
      }
    }
  })
}))
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)
const initialState = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { r: [local] },
    activeWorktreeId: workspaceId,
    activeWorkspaceExecutionHostId: 'local',
    gitGraphFiltersByWorktree: {}
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  viewport.rows = 20
  viewport.rendered = Infinity
  disposeGitGraphHistory(`${workspaceId}::git-graph`)
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})
const result: GitHistoryResult = {
  items: [{ id: 'a', subject: 'subject', message: 'subject', parentIds: [] }],
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
}
const renderTab = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
const loadedCount = () => gitGraphHistoryForTab(workspaceId).view.getState().result?.items.length

it.each([50_000])(
  'releases %i commits of replaced history while the pane stays mounted',
  async (count) => {
    viewport.rows = Infinity
    viewport.rendered = 40
    getHistory
      .mockReset()
      .mockImplementationOnce(async () => ({
        ...result,
        refs: 'all',
        hasMore: true,
        items: Array.from({ length: count }, (_, index) => ({
          id: `old-${index}`,
          subject: `Old ${index}`,
          message: `Old ${index}`,
          parentIds: []
        }))
      }))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ ...result, refs: 'head' })
    await renderTab()
    const replaced = (() => {
      const loaded = gitGraphHistoryForTab(workspaceId).view.getState().result!
      expect(loaded.items).toHaveLength(count)
      return new WeakRef(loaded)
    })()
    await act(async () =>
      useAppStore.setState({ gitGraphFiltersByWorktree: { [workspaceId]: 'head' } })
    )
    await act(async () => {
      await gitGraphHistoryForTab(workspaceId).settledResult()
    })
    expect(loadedCount()).toBe(1)
    getHistory.mockReset()
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(replaced.deref()).toBeUndefined()
  }
)
