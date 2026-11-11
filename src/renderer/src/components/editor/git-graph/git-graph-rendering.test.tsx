import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitGraphTab } from './git-graph-tab'
import * as graphSvg from '@/components/right-sidebar/source-control/sync/git-history-graph-svg'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

const { getHistory, getRefs, viewport } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getRefs: vi.fn(),
  viewport: { rows: 20 }
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
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)
let resize: (() => void) | undefined
const initialState = useAppStore.getState()
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => viewport.rows * 24
  )
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return (
      Number.parseFloat(
        this.firstElementChild?.getAttribute('style')?.match(/height: ([\d.]+)px/)?.[1] ?? '0'
      ) + 48
    )
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {
        if (resize === this.callback) {
          resize = undefined
        }
      }
      unobserve() {}
    }
  )
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

it.each([50_000, 500_000])(
  'releases %i commits of replaced history while the pane stays mounted',
  async (count) => {
    viewport.rows = 40
    const renderedGraph = vi.spyOn(graphSvg, 'GitHistoryGraphSvg')
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
    await act(async () => {
      const scroll = container.querySelector<HTMLDivElement>('div.overflow-y-auto')!
      scroll.scrollTop = (count - 40) * 24
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('network down')
    const replaced = (() => {
      const loaded = gitGraphHistoryForTab(workspaceId).view.getState().result!
      expect(loaded.items).toHaveLength(count)
      return [
        new WeakRef(renderedGraph.mock.calls[0]![0].viewModel),
        new WeakRef(loaded),
        new WeakRef(loaded.items),
        new WeakRef(loaded.items[count - 1]!)
      ]
    })()
    await act(async () =>
      useAppStore.setState({ gitGraphFiltersByWorktree: { [workspaceId]: 'head' } })
    )
    await act(async () => {
      await gitGraphHistoryForTab(workspaceId).settledResult()
    })
    expect(loadedCount()).toBe(1)
    getHistory.mockReset()
    renderedGraph.mockClear()
    await expectReleased(replaced)
    if (count === 500_000) {
      let controller = gitGraphHistoryForTab(workspaceId)
      const loadDisposable = async () => {
        getHistory.mockImplementationOnce(async () => ({
          ...result,
          items: [{ id: 'disposable', subject: 'Disposable', message: 'Body', parentIds: [] }]
        }))
        await act(async () => {
          await controller.refresh()
        })
        const payload = controller.view.getState().result!.items[0]!
        const row = renderedGraph.mock.calls.find(
          ([props]) => props.viewModel.historyItem.id === 'disposable'
        )![0].viewModel
        const weak = [new WeakRef(payload), new WeakRef(row)]
        getHistory.mockReset()
        renderedGraph.mockClear()
        return weak
      }
      const empty = await loadDisposable()
      getHistory.mockResolvedValueOnce({ ...result, items: [] })
      await act(async () => {
        await controller.refresh()
      })
      // A normal refresh commits past React's previous-render snapshot.
      getHistory.mockRejectedValueOnce(new Error('Empty refresh failed'))
      await act(async () => {
        await controller.refresh()
      })
      expect(container.textContent).toContain('Empty refresh failed')
      expect(loadedCount()).toBe(0)
      getHistory.mockReset()
      renderedGraph.mockClear()
      await expectReleased(empty)
      const missing = await loadDisposable()
      getHistory.mockRejectedValueOnce(new Error('failed filter'))
      await act(async () =>
        useAppStore.setState({ gitGraphFiltersByWorktree: { [workspaceId]: 'all' } })
      )
      await act(async () => {
        await controller.settledResult()
      })
      expect(loadedCount()).toBeUndefined()
      getHistory.mockRejectedValueOnce(new Error('Missing refresh failed'))
      await act(async () => {
        await controller.refresh()
      })
      expect(container.textContent).toContain('Missing refresh failed')
      expect(loadedCount()).toBeUndefined()
      getHistory.mockReset()
      renderedGraph.mockClear()
      await expectReleased(missing)
      const unmounted = await loadDisposable()
      await act(async () => {
        disposeGitGraphHistory(`${workspaceId}::git-graph`)
        root.unmount()
      })
      root = createRoot(container)
      controller = gitGraphHistoryForTab(workspaceId)
      await expectReleased(unmounted)
    }
  }
)

async function expectReleased(obsolete: WeakRef<object>[]) {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  for (const value of obsolete) {
    expect(value.deref()).toBeUndefined()
  }
}
