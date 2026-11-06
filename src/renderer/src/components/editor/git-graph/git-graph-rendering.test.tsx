// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-history-controller'
import { attachClosedEditorTabCleanup } from '../model-lifetime/retention/closed-editor-tab-controller'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { Repo } from '../../../../../shared/repo-types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitHistoryPanel } from '@/components/right-sidebar/source-control/sync/git-history-panel'
import { GitGraphTab } from './git-graph-tab'
import { GitGraphFilter } from './git-graph-filter'
import { useGitGraphHistory, gitGraphFilterSupported } from './use-git-graph-history'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import * as graph from '../../../../../shared/git/history/git-history-graph'

const { getHistory, getRefs } = vi.hoisted(() => ({ getHistory: vi.fn(), getRefs: vi.fn() }))
vi.mock('@/runtime/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory,
  getRuntimeGitRefs: getRefs
}))
vi.mock('./git-graph-details', () => ({ GitGraphDetails: () => null }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 28,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 28 })),
    measureElement: () => {}
  })
}))
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)
const initialState = useAppStore.getState()
const workspaceId = 'r::/repo'
const local = {
  id: workspaceId,
  repoId: 'r',
  path: '/repo',
  branch: 'refs/heads/main',
  hostId: 'local'
} as Worktree
const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}
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

it('keeps view models on expand and resize, rebuilding when history changes', async () => {
  const build = vi.spyOn(graph, 'buildGitHistoryViewModels')
  const render = (history: GitHistoryResult) => (
    <TooltipProvider>
      <GitHistoryPanel
        state={{ status: 'ready', result: history }}
        collapsed={false}
        onToggle={() => {}}
        onRefresh={() => {}}
        onLoadCommitFiles={async () => []}
        onOpenCommitFile={() => {}}
      />
    </TooltipProvider>
  )
  await act(async () => root.render(render(result)))
  expect(build).toHaveBeenCalledTimes(1)
  await act(async () =>
    (container.querySelector('[data-testid="git-history-row"]') as HTMLButtonElement).click()
  )
  await act(async () =>
    container
      .querySelector('[role="separator"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  )
  expect(build).toHaveBeenCalledTimes(1)
  await act(async () =>
    root.render(
      render({
        ...result,
        items: [...result.items, { id: 'b', subject: 'next', message: 'next', parentIds: [] }]
      })
    )
  )
  expect(build).toHaveBeenCalledTimes(2)
  expect(
    container.querySelector('[data-testid="git-history-row"]')?.getAttribute('aria-expanded')
  ).toBe('true')
})

it('disables the branch filter when an older host omits the refs echo', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphFilter
          worktreeId={workspaceId}
          filter="all"
          supported={gitGraphFilterSupported(result)}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('button')?.disabled).toBe(true)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphFilter
          worktreeId={workspaceId}
          filter="all"
          supported={gitGraphFilterSupported({ ...result, refs: 'all' })}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('button')?.disabled).toBe(false)
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
    const file = {
      id: `${workspaceId}::git-graph`,
      worktreeId: workspaceId,
      mode: 'git-graph',
      filePath: `${workspaceId}::git-graph`,
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: captureWorktreeOperationGenerationSnapshot({
          executionHostId: hostId,
          runtimeEnvironmentId: null
        })
      }
    } as OpenFile
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
