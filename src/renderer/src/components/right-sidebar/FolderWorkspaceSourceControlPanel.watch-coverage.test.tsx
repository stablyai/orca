// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type * as WorktreeGitCopy from '@/lib/worktree-git-copy'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useEditorExternalWatch } from '@/hooks/useEditorExternalWatch'
import FolderWorkspaceSourceControlPanel from './FolderWorkspaceSourceControlPanel'

const probes = vi.hoisted(() => ({
  status: vi.fn(async (_request: { worktreeId: string }) => {})
}))
vi.mock('./source-control/sync/git-status-refresh', () => ({
  refreshGitStatusForWorktree: probes.status
}))
vi.mock('./source-control/sync/use-git-status-upstream-ref-watch', () => ({
  useGitStatusUpstreamRefWatch: () => undefined
}))
vi.mock('./source-control/sync/use-refresh-on-host-contact', () => ({
  useRefreshOnHostContact: () => {}
}))
vi.mock('@/lib/worktree-git-copy', async (original) => ({
  ...(await original<typeof WorktreeGitCopy>()),
  resolveWorktreeGitCopyNow: (id: string, hostId: string) => ({
    worktreeId: id,
    hostId,
    transport: { kind: 'local' }
  })
}))
// Body work is covered elsewhere; this contract is about header-tier watch coverage.
vi.mock('./source-control/panel/panel', () => ({ SourceControlPanel: () => null }))

type RuntimeStream = {
  args: { selector: string; method: string; params: { worktree: string } }
  callbacks: { onResponse: (response: unknown) => void }
  unsubscribe: ReturnType<typeof vi.fn>
}
const fsListeners = new Set<(payload: FsChangedPayload) => void>()
let runtimeStreams: RuntimeStream[] = []
let watchWorktree: ReturnType<typeof vi.fn>
let unwatchWorktree: ReturnType<typeof vi.fn>
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  fsListeners.clear()
  runtimeStreams = []
  watchWorktree = vi.fn(async () => {})
  unwatchWorktree = vi.fn(async () => {})
  vi.stubGlobal('api', {
    fs: {
      watchWorktree,
      unwatchWorktree,
      onFsChanged: (listener: (payload: FsChangedPayload) => void) => {
        fsListeners.add(listener)
        return () => fsListeners.delete(listener)
      }
    },
    runtimeEnvironments: {
      subscribe: async (
        args: RuntimeStream['args'],
        callbacks: RuntimeStream['callbacks']
      ): Promise<{ unsubscribe: () => void }> => {
        const stream = { args, callbacks, unsubscribe: vi.fn() }
        runtimeStreams.push(stream)
        return { unsubscribe: stream.unsubscribe }
      },
      call: async () => ({ ok: true, result: {} })
    },
    worktrees: {
      onChanged: () => () => {},
      onGitStatusMetadataChanged: () => () => {}
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  probes.status.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function worktreeRow(repoId: string, path: string, index: number, extra: Partial<Worktree> = {}) {
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    branch: `refs/heads/feature-${index}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    displayName: `Child ${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: 0,
    hostId: 'local' as const,
    instanceId: `instance-${repoId}-${index}`,
    ...extra
  } satisfies Worktree
}

function setup(state: {
  children: Worktree[]
  others?: Worktree[]
  openFiles?: AppState['openFiles']
  lastVisitedAtByWorktreeId?: Record<string, number>
  changed?: ReadonlySet<string>
}) {
  const byRepo: Record<string, Worktree[]> = {}
  for (const row of [...state.children, ...(state.others ?? [])]) {
    ;(byRepo[row.repoId] ??= []).push(row)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the catalog, lineage and status fields the panel and watch owner read.
  useAppStore.setState({
    activeWorktreeId: 'folder:feature',
    activeWorkspaceKey: 'folder:feature',
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    repos: [
      { id: 'repo', displayName: 'Child', path: '/repo', kind: 'git' },
      { id: 'other', displayName: 'Other', path: '/other', kind: 'git' },
      {
        id: 'rrepo',
        displayName: 'Remote',
        path: '/remote',
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ],
    sshConnectionStates: new Map([
      [
        'nested-ssh',
        { targetId: 'nested-ssh', status: 'connected', error: null, reconnectAttempt: 0 }
      ]
    ]),
    worktreesByRepo: byRepo,
    folderWorkspaces: [
      { id: 'feature', name: 'Feature', folderPath: '/folder', projectGroupId: 'group' }
    ],
    workspaceLineageByChildKey: Object.fromEntries(
      state.children.map((row, i) => [
        row.id,
        {
          childWorkspaceKey: `worktree:${row.id}`,
          childInstanceId: row.instanceId,
          parentWorkspaceKey: 'folder:feature',
          parentInstanceId: null,
          createdAt: i
        }
      ])
    ),
    // Unchanged sections start collapsed; changed ones expand.
    gitStatusByWorktree: Object.fromEntries(
      state.children.map((row) => [
        row.id,
        state.changed?.has(row.id) ? [{ path: 'a.ts', status: 'modified', area: 'unstaged' }] : []
      ])
    ),
    openFiles: state.openFiles ?? [],
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId ?? {}
  } as unknown as Partial<AppState>)
}

function WatchOwner() {
  useEditorExternalWatch()
  return null
}
async function render(panel = true) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <WatchOwner />
        {panel && <FolderWorkspaceSourceControlPanel />}
      </TooltipProvider>
    )
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function settleAfter(send: () => void) {
  probes.status.mockClear()
  await act(async () => {
    send()
    // Debounce plus the existing 3 s activity floor, well inside the 60 s safety poll.
    await vi.advanceTimersByTimeAsync(4000)
  })
  return probes.status.mock.calls.map(([request]) => request.worktreeId)
}

const watchedPaths = (calls: { worktreePath: string }[][]) =>
  calls.map(([args]) => args!.worktreePath)

it('wakes only the owning collapsed or expanded section from file events beyond the former three watches', async () => {
  const children = Array.from({ length: 30 }, (_, i) => worktreeRow('repo', `/child-${i}`, i))
  setup({ children, changed: new Set([children[5]!.id]) })
  await render()
  // Every mounted local section holds a recursive root, collapsed and off-screen ones included.
  expect(watchedPaths(watchWorktree.mock.calls).sort()).toEqual(
    children.map((row) => row.path).sort()
  )
  const local = (path: string, kind: 'create' | 'update' | 'delete', file: string) => () => {
    for (const listener of fsListeners) {
      listener({ worktreePath: path, events: [{ kind, absolutePath: `${path}/${file}` }] })
    }
  }
  for (const target of [children[29]!, children[5]!]) {
    expect(await settleAfter(local(target.path, 'update', 'src/deep/tracked.ts'))).toEqual([
      target.id
    ])
    expect(await settleAfter(local(target.path, 'create', 'untracked.txt'))).toEqual([target.id])
    expect(await settleAfter(local(target.path, 'delete', 'untracked.txt'))).toEqual([target.id])
  }
})

it.each(['explicit', 'repository'] as const)(
  'watches an SSH section with %s runtime ownership through files.watch',
  async (ownership) => {
    const runtimeChild = worktreeRow(
      'rrepo',
      '/remote/child',
      0,
      ownership === 'explicit'
        ? { hostId: 'runtime:env-1', runtimeOwnerEnvironmentId: 'env-1' }
        : { hostId: undefined }
    )
    setup({ children: [runtimeChild] })
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'selected-elsewhere'
      }
    })
    await render()
    expect(watchWorktree).not.toHaveBeenCalled()
    expect(runtimeStreams.map((stream) => [stream.args.selector, stream.args.method])).toEqual([
      ['env-1', 'files.watch']
    ])
    const [stream] = runtimeStreams
    await act(async () =>
      stream!.callbacks.onResponse({ ok: true, result: { type: 'ready', subscriptionId: 'sub-1' } })
    )
    const recipients = await settleAfter(() =>
      stream!.callbacks.onResponse({
        ok: true,
        result: {
          type: 'changed',
          worktree: runtimeChild.id,
          events: [{ kind: 'create', absolutePath: '/remote/child/nested/new.txt' }]
        }
      })
    )
    expect(recipients).toEqual([runtimeChild.id])
    await render(false)
    expect(stream!.unsubscribe).toHaveBeenCalled()
  }
)

it('keeps ordinary warm watches, shares roots and releases only section-owned ones', async () => {
  const children = Array.from({ length: 30 }, (_, i) => worktreeRow('repo', `/child-${i}`, i))
  const others = [1, 2].map((i) => worktreeRow('other', `/other-${i}`, i))
  const openFile = (worktree: Worktree) => ({
    id: `${worktree.id}::file`,
    filePath: `${worktree.path}/file.ts`,
    relativePath: 'file.ts',
    worktreeId: worktree.id,
    language: 'typescript',
    isDirty: false,
    mode: 'edit' as const
  })
  setup({
    children,
    others,
    openFiles: [...others, children[0]!].map(openFile),
    // The three recently used workspaces: two ordinary ones and one that is also a section.
    lastVisitedAtByWorktreeId: Object.fromEntries(
      [...others, children[0]!].map((row, i) => [row.id, 100 + i])
    )
  })
  await render()
  const watched = watchedPaths(watchWorktree.mock.calls)
  // Thirty sections never take the recently used workspaces' slots.
  for (const row of others) {
    expect(watched).toContain(row.path)
  }
  // The section and an open file in the same worktree share one root.
  expect(watched.filter((path) => path === children[0]!.path)).toHaveLength(1)
  expect(unwatchWorktree).not.toHaveBeenCalled()

  await render(false)
  const released = watchedPaths(unwatchWorktree.mock.calls).sort()
  expect(released).toEqual(
    children
      .slice(1)
      .map((row) => row.path)
      .sort()
  )
})

it.each(['direct', 'nested'] as const)(
  'does not claim a watch for unserved %s SSH',
  async (route) => {
    const child = worktreeRow('rrepo', '/remote/child', 0, { hostId: 'ssh:nested-ssh' })
    setup({ children: [child] })
    useAppStore.setState({
      repos: useAppStore.getState().repos.map((repo) =>
        repo.id === 'rrepo'
          ? {
              ...repo,
              connectionId: 'nested-ssh',
              executionHostId: route === 'nested' ? 'runtime:env-1' : 'ssh:nested-ssh'
            }
          : repo
      )
    })
    await render()
    expect(watchWorktree).not.toHaveBeenCalled()
    expect(runtimeStreams).toEqual([])
    // Scheduling is preserved; unsupported SSH status still reaches the original remote rejection boundary.
    expect(probes.status.mock.calls.map(([request]) => request.worktreeId)).toEqual([child.id])
  }
)
