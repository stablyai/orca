import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'
import { attachClosedEditorTabCleanup } from '../model-lifetime/retention/closed-editor-tab-controller'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/workspace/ownership/worktree-operation-generation'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitGraphTab } from './git-graph-tab'
import { GitGraphFilter } from './git-graph-filter'
import * as commitSupport from '@/runtime/source-control/git/git-commit-actions-capability'
import { useGitGraphHistory } from './use-git-graph-history'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

const { getHistory, getRefs } = vi.hoisted(() => ({ getHistory: vi.fn(), getRefs: vi.fn() }))
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
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 28 })),
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

it('renders converging branch lanes and a detached root without duplicate child keys', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  getHistory.mockReset().mockResolvedValue({
    ...result,
    items: [
      { id: 'a', subject: 'a', message: 'a', parentIds: ['root'] },
      { id: 'b', subject: 'b', message: 'b', parentIds: ['root'] },
      { id: 'c', subject: 'c', message: 'c', parentIds: ['root'] },
      { id: 'detached', subject: 'detached', message: 'detached', parentIds: [] },
      { id: 'root', subject: 'root', message: 'root', parentIds: [] }
    ]
  })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
  )
  expect(errors.mock.calls.filter(([message]) => String(message).includes('same key'))).toEqual([])
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

it.each(['local', 'ssh:A'] as const)(
  'retains %s twin history across workspace switches, then follows its tab owner move',
  async (hostId) => {
    useAppStore.setState({
      repos: [
        ...useAppStore.getState().repos,
        { ...repo, executionHostId: 'ssh:A', connectionId: 'A' }
      ],
      worktreesByRepo: { r: [local, { ...local, hostId: 'ssh:A' }] },
      activeWorkspaceExecutionHostId: hostId
    })
    const cleanup = attachClosedEditorTabCleanup(useAppStore)
    const original = useAppStore.getState().openFiles
    const file: OpenFile = {
      id: `${workspaceId}::git-graph`,
      worktreeId: workspaceId,
      mode: 'git-graph',
      relativePath: 'Git Graph',
      language: 'plaintext',
      isDirty: false,
      filePath: `${workspaceId}::git-graph`,
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: captureWorktreeOperationGenerationSnapshot({
          executionHostId: hostId,
          runtimeEnvironmentId: null
        })
      }
    }
    useAppStore.setState({ openFiles: [...original, file] })
    const render = () => (
      <TooltipProvider>
        <GitGraphTab worktreeId={workspaceId} />
      </TooltipProvider>
    )
    const page = {
      ...result,
      items: [...result.items, { id: 'b', subject: 'second', message: 'second', parentIds: [] }],
      refs: 'all' as const
    }
    getHistory.mockReset().mockResolvedValueOnce(page)
    try {
      await act(async () => root.render(render()))
      expect(getHistory.mock.calls[0]?.[0].connectionId).toBe(hostId === 'ssh:A' ? 'A' : undefined)
      await act(async () => {
        const commit = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'second'
        )!
        commit.click()
        const scroll = container.querySelector<HTMLDivElement>('div.overflow-y-auto')!
        scroll.scrollTop = 144
        scroll.dispatchEvent(new Event('scroll'))
      })
      await act(async () => root.render(null))
      await act(async () =>
        useAppStore.setState({ activeWorktreeId: 'other', activeWorkspaceExecutionHostId: 'local' })
      )
      expect(gitGraphScope(workspaceId)).toBeNull()
      expect(gitGraphHistoryForTab(workspaceId).view.getState().selectedId).toBe('b')
      await act(async () =>
        useAppStore.setState({
          activeWorktreeId: workspaceId,
          activeWorkspaceExecutionHostId: hostId
        })
      )
      await act(async () => root.render(render()))
      expect(container.querySelector('[data-current="true"]')?.textContent).toContain('second')
      expect(container.querySelector<HTMLDivElement>('div.overflow-y-auto')?.scrollTop).toBe(144)
      expect(getHistory).toHaveBeenCalledTimes(1)
      await act(async () => root.render(null))
      useAppStore.setState({
        worktreesByRepo: { r: [{ ...local, hostId: hostId === 'local' ? 'ssh:A' : 'local' }] }
      })
      expect(gitGraphHistoryForTab(workspaceId).view.getState().result).toBeUndefined()
      expect(gitGraphHistoryForTab(workspaceId).scrollOffset).toBe(0)
      await act(async () => root.render(render()))
      const movedHost = hostId === 'local' ? 'ssh:A' : 'local'
      getHistory.mockResolvedValueOnce({ ...result, refs: 'all' })
      await act(async () =>
        useAppStore.setState({
          openFiles: [
            ...original,
            {
              ...file,
              operationProvenance: {
                ownershipProjection: 'explicit',
                generation: captureWorktreeOperationGenerationSnapshot({
                  executionHostId: movedHost,
                  runtimeEnvironmentId: null
                })
              }
            }
          ]
        })
      )
      expect(getHistory.mock.calls.at(-1)?.[0].connectionId).toBe(
        movedHost === 'ssh:A' ? 'A' : undefined
      )
      expect(gitGraphHistoryForTab(workspaceId).view.getState().selectedId).toBe('a')
      await act(async () => root.render(null))
      useAppStore.setState({ openFiles: original })
      expect(gitGraphHistoryForTab(workspaceId).view.getState().result).toBeUndefined()
    } finally {
      cleanup()
      useAppStore.setState({ openFiles: original })
    }
  }
)

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

it('canonicalizes selected refs before requesting history', async () => {
  let history: ReturnType<typeof useGitGraphHistory>
  function History() {
    history = useGitGraphHistory(workspaceId)
    return null
  }
  getHistory.mockReset().mockResolvedValue({ ...result, refs: 'all' })
  await act(async () => root.render(<History />))
  getHistory.mockClear().mockResolvedValue({
    ...result,
    refs: ['refs/heads/main', 'refs/heads/topic'],
    resolvedRefs: ['refs/heads/main', 'refs/heads/topic']
  })
  await act(async () => {
    history!.changeFilter(['refs/heads/topic', 'refs/heads/main', 'refs/heads/topic'])
    await history!.controller.settledResult()
  })
  expect(getHistory.mock.calls[0]?.[1].refs).toEqual(['refs/heads/main', 'refs/heads/topic'])
})
