// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-history-controller'
import { attachClosedEditorTabCleanup } from '../model-lifetime/retention/closed-editor-tab-controller'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitHistoryPanel } from '@/components/right-sidebar/source-control/sync/git-history-panel'
import { GitGraphTab } from './git-graph-tab'
import { GitGraphFilter } from './git-graph-filter'
import { useGitGraphHistory, gitGraphFilterSupported } from './use-git-graph-history'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import * as graph from '../../../../../shared/git/history/git-history-graph'

const { scope, getHistory } = vi.hoisted(() => ({
  scope: {
    target: { kind: 'local' },
    route: { executionHostId: 'local', runtimeEnvironmentId: null },
    worktree: { path: '/repo' }
  },
  getHistory: vi.fn()
}))
vi.mock('@/lib/git-graph-tab', () => ({
  gitGraphScope: () => scope,
  useGitGraphScope: () => scope,
  gitGraphScopeInputs: () => ({}),
  GIT_GRAPH_REFRESH_EVENT: 'orca:git-graph-refresh'
}))
vi.mock('@/runtime/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
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
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  disposeGitGraphHistory('w::git-graph')
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
          worktreeId="w"
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
          worktreeId="w"
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
    history = useGitGraphHistory('w')
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
    window.dispatchEvent(new CustomEvent('orca:git-graph-refresh', { detail: 'w' }))
  )
  expect(history!.result?.historyToken).toBe('refreshed')
  expect(getHistory.mock.calls.at(-1)?.[1].wakeWslDistro).toBe(false)
})

it('retains history, selection and scroll across remounts, and drops them when a hidden tab closes', async () => {
  const cleanup = attachClosedEditorTabCleanup(useAppStore)
  const original = useAppStore.getState().openFiles
  const file = {
    id: 'w::git-graph',
    worktreeId: 'w',
    mode: 'git-graph',
    filePath: 'w::git-graph'
  } as OpenFile
  useAppStore.setState({ openFiles: [...original, file] })
  const render = () => (
    <TooltipProvider>
      <GitGraphTab worktreeId="w" />
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
    await act(async () => root.render(render()))
    expect(container.querySelector('[data-current="true"]')?.textContent).toContain('second')
    expect(container.querySelector<HTMLDivElement>('div.overflow-y-auto')?.scrollTop).toBe(144)
    expect(getHistory).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    useAppStore.setState({ openFiles: original })
    expect(gitGraphHistoryForTab('w').view.getState().result).toBeUndefined()
  } finally {
    cleanup()
    useAppStore.setState({ openFiles: original })
  }
})

it('retrieves a distant parent in one operation without cutting off after ten pages', async () => {
  let history: ReturnType<typeof useGitGraphHistory>
  function History() {
    history = useGitGraphHistory('w')
    return null
  }
  const ids = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'parent']
  getHistory.mockReset().mockResolvedValueOnce({ ...result, hasMore: true, historyToken: 'pinned' })
  await act(async () => root.render(<History />))
  for (const id of ids) {
    getHistory.mockResolvedValueOnce({
      ...result,
      items: [{ id, subject: id, message: id, parentIds: [] }],
      hasMore: true,
      historyToken: 'pinned'
    })
  }
  await act(async () => {
    await history!.reveal('parent')
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
