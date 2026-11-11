import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitGraphTab } from './git-graph-tab'
import { GitGraphFilter } from './git-graph-filter'
import * as commitSupport from '@/runtime/source-control/git/git-commit-actions-capability'
import { useGitGraphHistory } from './use-git-graph-history'
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

it('keeps the branch checkout strip open after selecting a badge context-menu action', async () => {
  vi.spyOn(commitSupport, 'useGitCommitActionsSupport').mockReturnValue({
    supported: true,
    reason: undefined
  })
  getHistory.mockReset().mockResolvedValue({
    ...result,
    items: [
      {
        ...result.items[0],
        references: [{ id: 'refs/heads/topic', name: 'topic' }]
      }
    ]
  })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
  await act(async () => {
    container
      .querySelector('[title="topic"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
  })
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Check out branch')!
      .click()
  })
  expect(container.querySelector('form')?.textContent).toContain('Check out branch topic?')
})

it('recovers silently after each later token expiry and ignores refreshes for other worktrees', async () => {
  let history: ReturnType<typeof useGitGraphHistory>
  function History() {
    history = useGitGraphHistory(workspaceId)
    return <span>{history.error}</span>
  }
  const page = { ...result, refs: 'all' as const, hasMore: true, historyToken: 'first' }
  getHistory.mockReset().mockResolvedValueOnce(page)
  await act(async () => root.render(<History />))
  const changed = { ...page, items: [], historyChanged: true }
  getHistory
    .mockResolvedValueOnce(changed)
    .mockResolvedValueOnce({ ...page, historyToken: 'second' })
  await act(async () => {
    await history!.loadMore()
  })
  expect(history!.result?.historyToken).toBe('second')
  getHistory
    .mockResolvedValueOnce(changed)
    .mockResolvedValueOnce({ ...page, historyToken: 'third' })
  await act(async () => {
    await history!.loadMore()
  })
  expect(history!.result?.historyToken).toBe('third')
  expect(history!.error).toBeUndefined()
  getHistory.mockResolvedValue({ ...page, historyToken: 'refreshed' })
  await act(async () =>
    window.dispatchEvent(new CustomEvent('orca:git-graph-refresh', { detail: 'other' }))
  )
  expect(history!.result?.historyToken).toBe('third')
  await act(async () =>
    window.dispatchEvent(new CustomEvent('orca:git-graph-refresh', { detail: workspaceId }))
  )
  expect(history!.result?.historyToken).toBe('refreshed')
  expect(getHistory.mock.calls.at(-1)?.[1].wakeWslDistro).toBe(false)
})

it('keeps an older selection, loaded depth and scroll through refresh', async () => {
  const items = Array.from({ length: 150 }, (_, index) => ({
    id: `commit-${index}`,
    subject: `Commit ${index}`,
    message: `Commit ${index}`,
    parentIds: index < 149 ? [`commit-${index + 1}`] : []
  }))
  const page = (skip: number): GitHistoryResult => ({
    ...result,
    refs: 'all',
    historyToken: 'before-refresh',
    items: items.slice(skip, skip + 50),
    hasMore: skip < 100
  })
  getHistory.mockReset().mockResolvedValueOnce(page(0))
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
  const controller = gitGraphHistoryForTab(workspaceId)
  getHistory.mockResolvedValueOnce(page(50)).mockResolvedValueOnce(page(100))
  await act(async () => {
    await controller.loadMore()
    await controller.loadMore()
  })
  const scroll = container.querySelector<HTMLDivElement>('div.overflow-y-auto')!
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Commit 110')!
      .click()
    scroll.scrollTop = 2400
    scroll.dispatchEvent(new Event('scroll'))
  })
  const refreshed = [
    { id: 'new-tip', subject: 'New commit', message: 'New commit', parentIds: ['commit-0'] },
    ...items
  ]
  const refreshedPage = (skip: number): GitHistoryResult => ({
    ...result,
    refs: 'all',
    historyToken: 'after-refresh',
    items: refreshed.slice(skip, skip + 50),
    hasMore: true
  })
  let finish!: (page: GitHistoryResult) => void
  getHistory
    .mockResolvedValueOnce(refreshedPage(0))
    .mockImplementationOnce(
      () =>
        new Promise<GitHistoryResult>((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce(refreshedPage(100))
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Refresh commits"]')!.click()
  })
  expect(container.querySelector('[data-current="true"]')?.textContent).toContain('Commit 110')
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  await act(async () => {
    finish(refreshedPage(50))
    await controller.loadMore()
  })
  expect(container.querySelector('[data-current="true"]')?.textContent).toContain('Commit 110')
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  expect(scroll.scrollTop).toBe(2400)

  getHistory
    .mockResolvedValueOnce(refreshedPage(0))
    .mockResolvedValueOnce(refreshedPage(50))
    .mockResolvedValueOnce(refreshedPage(100))
  await act(async () => {
    window.dispatchEvent(new CustomEvent('orca:git-graph-refresh', { detail: workspaceId }))
    await controller.loadMore()
  })
  expect(container.querySelector('[data-current="true"]')?.textContent).toContain('Commit 110')
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  expect(scroll.scrollTop).toBe(2400)

  getHistory
    .mockResolvedValueOnce({ ...result, items: [], historyChanged: true })
    .mockResolvedValueOnce(refreshedPage(0))
    .mockResolvedValueOnce(refreshedPage(50))
    .mockResolvedValueOnce(refreshedPage(100))
  await act(async () => {
    await controller.loadMore()
  })
  expect(container.querySelector('[data-current="true"]')?.textContent).toContain('Commit 110')
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  expect(scroll.scrollTop).toBe(2400)
})

async function loadOlderHistory() {
  const items = Array.from({ length: 300 }, (_, index) => ({
    id: `commit-${index}`,
    subject: `Commit ${index}`,
    message: `Commit ${index}`,
    parentIds: []
  }))
  const page = (skip: number): GitHistoryResult => ({
    ...result,
    refs: 'all',
    historyToken: 'pinned',
    items: items.slice(skip, skip + 50),
    hasMore: skip < 250
  })
  getHistory.mockReset().mockImplementation(async (_owner, options) => page(options.skip))
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
  const controller = gitGraphHistoryForTab(workspaceId)
  await act(async () => {
    await controller.loadMore()
    await controller.loadMore()
  })
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Commit 110')!
      .click()
  })
  getHistory.mockClear()
  return { controller, items, page }
}

it('bounds refresh to one extra page when the selected commit has vanished', async () => {
  const { controller, items } = await loadOlderHistory()
  const remaining = items.filter((item) => item.id !== 'commit-110')
  getHistory.mockImplementation(async (_owner, options) => ({
    ...result,
    refs: 'all',
    items: remaining.slice(options.skip, options.skip + 50),
    hasMore: options.skip < 250
  }))
  const scroll = container.querySelector<HTMLDivElement>('div.overflow-y-auto')!
  await act(async () => {
    scroll.scrollTop = 2400
    controller.scrollOffset = 2400
    await controller.refresh()
  })
  expect(getHistory).toHaveBeenCalledTimes(4)
  expect(container.querySelectorAll('[data-current]')).toHaveLength(200)
  expect(container.querySelector('[data-current="true"] button[title="Commit 0"]')).not.toBeNull()
  expect(container.querySelector('aside h2')?.textContent).toBe('Commit 0')
  expect(scroll.scrollTop).toBe(0)
})

it('keeps a newer selection and its details during refresh and after a partial failure', async () => {
  const { controller, page } = await loadOlderHistory()
  let finish!: (page: GitHistoryResult) => void
  getHistory.mockResolvedValueOnce(page(0)).mockImplementationOnce(
    () =>
      new Promise<GitHistoryResult>((resolve) => {
        finish = resolve
      })
  )
  let refreshing!: Promise<GitHistoryResult | undefined>
  await act(async () => {
    refreshing = controller.refresh()
  })
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Commit 120')!
      .click()
    finish(page(50))
    await refreshing
  })
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  expect(container.querySelector('[data-current="true"] button[title="Commit 120"]')).not.toBeNull()
  expect(container.querySelector('aside h2')?.textContent).toBe('Commit 120')

  getHistory
    .mockResolvedValueOnce(page(0))
    .mockRejectedValueOnce(Object.assign(new Error('Transport failure'), { message: '' }))
  await act(async () => {
    await controller.refresh()
  })
  expect(container.querySelectorAll('[data-current]')).toHaveLength(150)
  expect(container.querySelector('[data-current="true"] button[title="Commit 120"]')).not.toBeNull()
  expect(container.querySelector('aside h2')?.textContent).toBe('Commit 120')
})

it('waits for an in-flight page before retrieving a distant parent in one operation', async () => {
  let history: ReturnType<typeof useGitGraphHistory>
  function History() {
    history = useGitGraphHistory(workspaceId)
    return null
  }
  const ids = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'parent']
  getHistory.mockReset().mockResolvedValueOnce({ ...result, hasMore: true, historyToken: 'pinned' })
  await act(async () => root.render(<History />))
  let finish!: (page: GitHistoryResult) => void
  getHistory.mockImplementationOnce(
    () =>
      new Promise<GitHistoryResult>((resolve) => {
        finish = resolve
      })
  )
  const loading = history!.loadMore()
  for (const id of ids.slice(1)) {
    getHistory.mockResolvedValueOnce({
      ...result,
      items: [{ id, subject: id, message: id, parentIds: [] }],
      hasMore: true,
      historyToken: 'pinned'
    })
  }
  await act(async () => {
    const revealing = history!.reveal('parent')
    finish({
      ...result,
      items: [{ id: 'b', subject: 'b', message: 'b', parentIds: [] }],
      hasMore: true,
      historyToken: 'pinned'
    })
    await loading
    await revealing
  })
  expect(history!.selectedId).toBe('parent')
  expect(history!.result?.items.map((item) => item.id)).toEqual([
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'parent'
  ])
})

it('keeps retrieved pages without revealing over a newer selection or parent navigation', async () => {
  getHistory.mockReset().mockResolvedValueOnce({ ...result, hasMore: true })
  const controller = gitGraphHistoryForTab(workspaceId)
  const detach = controller.attach()
  await controller.loadMore()
  let finish!: (page: GitHistoryResult) => void
  getHistory.mockImplementationOnce(
    () =>
      new Promise<GitHistoryResult>((resolve) => {
        finish = resolve
      })
  )
  const revealing = controller.reveal('parent')
  await Promise.resolve()
  controller.select('a')
  finish({
    ...result,
    items: [{ id: 'parent', subject: 'parent', message: 'parent', parentIds: [] }],
    hasMore: true
  })
  expect(await revealing).toBe(-1)
  expect(controller.view.getState().result?.items.map((item) => item.id)).toEqual(['a', 'parent'])
  expect(controller.view.getState().selectedId).toBe('a')
  expect(controller.view.getState().revealId).toBeUndefined()

  getHistory.mockImplementationOnce(
    () =>
      new Promise<GitHistoryResult>((resolve) => {
        finish = resolve
      })
  )
  const older = controller.reveal('older')
  await Promise.resolve()
  const newer = controller.reveal('a')
  finish({ ...result, items: [{ id: 'older', subject: 'older', message: 'older', parentIds: [] }] })
  expect(await older).toBe(-1)
  expect(await newer).toBe(0)
  expect(controller.view.getState().selectedId).toBe('a')
  expect(controller.view.getState().revealId).toBe('a')
  detach()
})

it('applies checkbox choices once on picker close, with no choices returning to All', async () => {
  const onChange = vi.fn()
  getRefs.mockReset().mockResolvedValue([
    { id: 'refs/heads/b', name: 'b', type: 'head' },
    { id: 'refs/heads/a', name: 'a', type: 'head' }
  ])
  const render = (filter: 'all' | string[]) =>
    root.render(
      <TooltipProvider>
        <GitGraphFilter worktreeId={workspaceId} filter={filter} supported onChange={onChange} />
      </TooltipProvider>
    )
  await act(async () => render('all'))
  await act(async () => container.querySelector('button')!.click())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  })
  const checkboxes = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
  expect(checkboxes).toHaveLength(2)
  await act(async () => checkboxes[0]!.click())
  await act(async () => checkboxes[1]!.click())
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => container.querySelector('button')!.click())
  expect(onChange.mock.calls).toEqual([[['refs/heads/a', 'refs/heads/b']]])

  await act(async () => render(['refs/heads/a', 'refs/heads/b']))
  await act(async () => container.querySelector('button')!.click())
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  })
  for (const checkbox of document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) {
    await act(async () => checkbox.click())
  }
  expect(onChange).toHaveBeenCalledTimes(1)
  await act(async () => container.querySelector('button')!.click())
  expect(onChange.mock.calls.at(-1)).toEqual(['all'])

  const openPicker = async () => {
    await act(async () => container.querySelector('button')!.click())
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
    })
  }
  await act(async () => render('all'))
  await openPicker()
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  await act(async () =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
  )
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(onChange).toHaveBeenCalledTimes(2)

  await openPicker()
  expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  await act(async () => useAppStore.setState({ worktreesByRepo: {} }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => useAppStore.setState({ worktreesByRepo: { r: [local] } }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(onChange).toHaveBeenCalledTimes(2)
  await openPicker()
  expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')
})

it('keeps the confirm strip across tab switches, discarding it on navigation, filter change and close', async () => {
  getHistory.mockResolvedValue(result)
  const render = () => (
    <TooltipProvider>
      <GitGraphTab worktreeId={workspaceId} />
    </TooltipProvider>
  )
  await act(async () => root.render(render()))
  const controller = gitGraphHistoryForTab(workspaceId)
  await act(async () => controller.actions.request('revert', result.items[0]!))
  expect(container.textContent).toContain('Revert a?')
  await act(async () => root.render(<div>Another tab</div>))
  await act(async () => root.render(render()))
  expect(container.textContent).toContain('Revert a?')
  await act(async () => controller.select('a'))
  expect(container.textContent).not.toContain('Revert a?')
  await act(async () => controller.actions.request('revert', result.items[0]!))
  await act(async () =>
    useAppStore.setState({ gitGraphFiltersByWorktree: { [workspaceId]: 'head' } })
  )
  expect(container.textContent).not.toContain('Revert a?')
  await act(async () => controller.actions.request('revert', result.items[0]!))
  await act(async () => {
    disposeGitGraphHistory(`${workspaceId}::git-graph`)
    root.render(<div>Closed</div>)
  })
  await act(async () => root.render(render()))
  expect(container.textContent).not.toContain('Revert a?')
})
const longHistory = Array.from({ length: 200 }, (_, index) => ({
  id: `commit-${index}`,
  subject: `Commit ${index}`,
  message: `Commit ${index}`,
  parentIds: []
}))
const longPage = (skip: number): GitHistoryResult => ({
  ...result,
  refs: 'all',
  historyToken: 'long',
  items: longHistory.slice(skip, skip + 50),
  hasMore: skip + 50 < longHistory.length
})
const renderTab = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
const loadedCount = () => gitGraphHistoryForTab(workspaceId).view.getState().result?.items.length

it('pages a pane taller than the loaded commits until they overflow it, and again when it grows', async () => {
  viewport.rows = 120
  getHistory.mockReset().mockImplementation(async (_owner, options) => longPage(options.skip))
  await renderTab()
  expect(loadedCount()).toBe(150)
  viewport.rows = 400
  await renderTab()
  expect(loadedCount()).toBe(200)
  expect(container.textContent).not.toContain('Load more')
})

it('leaves a failed page to Load more, even after switching tabs away and back', async () => {
  viewport.rows = Infinity
  getHistory
    .mockReset()
    .mockResolvedValueOnce(longPage(0))
    .mockRejectedValueOnce(new Error('network down'))
    .mockImplementation(async (_owner, options) => longPage(options.skip))
  await renderTab()
  await act(async () => root.render(<div>Another tab</div>))
  await renderTab()
  expect(loadedCount()).toBe(50)
  expect(container.textContent).toContain('network down')
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Load more')!
      .click()
  })
  expect(loadedCount()).toBe(200)
})

it('stops paging on a page that adds no commits, and ends on an empty last page', async () => {
  viewport.rows = Infinity
  getHistory.mockReset().mockResolvedValue(longPage(0))
  await renderTab()
  await renderTab()
  expect(loadedCount()).toBe(50)
  expect(getHistory).toHaveBeenCalledTimes(2)
  getHistory.mockResolvedValue({ ...longPage(0), items: [], hasMore: false })
  await act(async () => {
    await gitGraphHistoryForTab(workspaceId).loadMore()
  })
  expect(container.textContent).not.toContain('Load more')
})

it.each([50_000, 500_000])(
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
