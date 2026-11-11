// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FileExplorerRepositoryObserver } from './file-explorer-repository-observer'
import { FileExplorerDirectoryCache } from './file-explorer-directory-cache'
import { useFileExplorerRepositories } from './use-file-explorer-repositories'
import type { DirCache, TreeNode } from './file-explorer-types'
import type { GitRepositoryStatusRequest } from '../../../../../../shared/git/status/git-repository-status'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'

const { read, supports } = vi.hoisted(() => ({ read: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: read,
  supportsRuntimeGitRepositories: supports
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  useFileListOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ target: { kind: 'local' } })
}))
vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: () => () => {}
}))
vi.mock('@/lib/window-activity/window-visibility-interval', () => ({ isWindowVisible: () => true }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  read.mockReset()
  supports.mockReset()
})
const owner = { kind: 'local' } as const
const node = (relativePath: string, isDirectory = false): TreeNode => ({
  name: relativePath.split('/').at(-1)!,
  path: `/w/${relativePath}`,
  relativePath,
  isDirectory,
  depth: 0,
  operationOwner: owner
})
function event(path: string, kind = 'update', isDirectory = false): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        payload: { worktreePath: '/w', events: [{ absolutePath: `/w/${path}`, kind, isDirectory }] }
      }
    })
  )
}

it.each([1000, 10000])(
  'reconciles one listing and local membership among %i siblings through the real subscription',
  async (count) => {
    vi.useFakeTimers()
    supports.mockResolvedValue(true)
    const repositories = new Set<string>()
    const probes: string[][] = []
    read.mockImplementation(async (_route, request: GitRepositoryStatusRequest) => {
      if (request.repositoryIntent === 'probe') {
        probes.push(request.repositoryPaths!)
      }
      return {
        repositoryStatuses: request.repositoryPaths!.map((path) => ({
          path,
          kind: repositories.has(path) ? 'repository' : 'absent',
          ...(repositories.has(path) && request.repositoryIntent === 'status'
            ? { status: { entries: [], conflictOperation: 'unknown' } }
            : {})
        }))
      }
    })
    let rowVisits = 0
    let siblingMetadata = 0
    const store = new FileExplorerDirectoryCache()
    const cache: Record<string, DirCache> = {
      '/w': {
        operationOwner: owner,
        children: Array.from({ length: count }, (_, index) => ({
          ...node(`folder${index}`, true),
          get outsideProject() {
            rowVisits++
            return undefined
          }
        }))
      }
    }
    for (let index = 0; index < count; index++) {
      cache[`/w/folder${index}`] = {
        operationOwner: owner,
        children: [],
        get repositoryMarker() {
          if (index) {
            siblingMetadata++
          }
          return false
        }
      }
    }
    store.update(() => ({
      dirCache: cache,
      sourceWorkspaceId: 'folder:w',
      changedPaths: [],
      reset: true
    }))
    const expanded = new Set(['/w/folder0'])
    const fixture = renderHook(
      ({ visible }) =>
        useFileExplorerRepositories(
          'folder:w',
          '/w',
          '/w',
          { dirCacheStore: store },
          expanded,
          visible,
          true
        ),
      { initialProps: { visible: true } }
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
    probes.length = 0
    supports.mockClear()
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(probes).toEqual([])
    expect(supports).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    fixture.rerender({ visible: false })
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    fixture.rerender({ visible: true })
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(probes).toEqual([])
    expect(supports).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    rowVisits = 0
    siblingMetadata = 0
    let metadataVisits = 0
    const entries = Map.prototype.entries
    const countEntries = function* (this: Map<unknown, unknown>) {
      for (const pair of entries.call(this)) {
        if (typeof pair[0] === 'string' && /^folder\d+/.test(pair[0])) {
          metadataVisits++
        }
        yield pair
      }
    }
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(countEntries)
    vi.spyOn(Map.prototype, 'values').mockImplementation(function* (this: Map<unknown, unknown>) {
      for (const [, value] of countEntries.call(this)) {
        yield value
      }
    })
    vi.spyOn(Map.prototype, 'keys').mockImplementation(function* (this: Map<unknown, unknown>) {
      for (const [key] of countEntries.call(this)) {
        yield key
      }
    })
    const file = {
      ...node('folder0/new.txt'),
      get outsideProject() {
        rowVisits++
        return undefined
      }
    }
    act(() =>
      store.update((previous) => ({
        dirCache: {
          ...previous,
          '/w/folder0': { operationOwner: owner, repositoryMarker: false, children: [file] }
        },
        changedPaths: ['/w/folder0']
      }))
    )
    expect(rowVisits).toBe(1)
    expect(siblingMetadata).toBe(0)
    // One candidate, one direct dependency and their ancestor/index bookkeeping, independent of width.
    expect(metadataVisits).toBeLessThanOrEqual(30)
    vi.restoreAllMocks()
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(probes).toEqual([])

    repositories.add('folder0/new')
    act(() => {
      store.update((previous) => ({
        dirCache: {
          ...previous,
          '/w/folder0': {
            operationOwner: owner,
            repositoryMarker: false,
            children: [node('folder0/new', true)]
          }
        },
        changedPaths: ['/w/folder0']
      }))
      store.update((previous) => ({
        dirCache: {
          ...previous,
          '/w/folder0/new': { operationOwner: owner, repositoryMarker: true, children: [] }
        },
        changedPaths: ['/w/folder0/new']
      }))
      event('folder0/new/.git', 'create')
    })
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(probes).toEqual([['folder0/new']])
    expect(fixture.result.current.sources.map((source) => source.path)).toEqual(['folder0/new'])

    fixture.rerender({ visible: false })
    rowVisits = 0
    for (let index = 0; index < 20; index++) {
      act(() => {
        store.update((previous) => ({
          dirCache: {
            ...previous,
            '/w/transient': { children: [] },
            '/w/folder0': { ...cache['/w/folder0'] }
          },
          changedPaths: ['/w/transient', '/w/folder0']
        }))
        store.update((previous) => {
          const { '/w/transient': _removed, ...next } = previous
          return {
            dirCache: { ...next, '/w/folder0': cache['/w/folder0'] },
            changedPaths: ['/w/transient', '/w/folder0']
          }
        })
      })
    }
    probes.length = 0
    supports.mockClear()
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(rowVisits).toBe(0)
    expect(probes).toEqual([])
    expect(supports).not.toHaveBeenCalled()
    fixture.rerender({ visible: true })
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(fixture.result.current.sources).toEqual([])
    expect(rowVisits).toBe(0)
    expect(probes).toEqual([['folder0']])
    probes.length = 0

    repositories.add('folder1')
    act(() => event('folder1/.git/config'))
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(probes).toEqual([['folder1']])
    expect(fixture.result.current.sources.map((source) => source.path)).toEqual(['folder1'])
    repositories.delete('folder1')
    act(() => event('folder1/.git', 'delete'))
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(fixture.result.current.sources).toEqual([])
    probes.length = 0
    await act(() => vi.advanceTimersByTimeAsync(600_000))
    expect(probes).toEqual([])
    fixture.unmount()
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('publishes atomic provenance, serializes reentry and never commits an abandoned render', async () => {
  supports.mockResolvedValue(true)
  read.mockResolvedValue({ repositoryStatuses: [] })
  const store = new FileExplorerDirectoryCache()
  const notifications: string[][] = []
  store.subscribeChanges((commit) => {
    expect(store.getSnapshot().dirCache).toBe(commit.dirCache)
    notifications.push([...commit.changedPaths])
    if (commit.changedPaths.includes('/w/a')) {
      store.update((previous) => ({
        dirCache: { ...previous, '/w/b': { children: [] } },
        changedPaths: ['/w/b']
      }))
    }
  })
  store.update(() => ({
    dirCache: { '/w': { operationOwner: owner, repositoryMarker: false, children: [] } },
    sourceWorkspaceId: 'folder:w',
    changedPaths: ['/w']
  }))
  const before = store.getSnapshot()
  const expanded = new Set<string>()
  const fixture = renderHook(
    ({ fail }) => {
      const result = useFileExplorerRepositories(
        'folder:w',
        '/w',
        '/w',
        { dirCacheStore: store },
        expanded,
        false,
        false
      )
      if (fail) {
        throw new Error('abandoned render')
      }
      return result
    },
    { initialProps: { fail: false } }
  )
  act(() =>
    store.update((previous) => ({
      dirCache: { ...previous, '/w/a': { children: [] } },
      changedPaths: ['/w/a']
    }))
  )
  expect(notifications).toEqual([['/w'], ['/w/a'], ['/w/b']])
  expect(before.dirCache['/w/a']).toBeUndefined()
  const committed = store.getSnapshot()
  act(() => store.update((previous) => ({ dirCache: previous, changedPaths: ['/w/a'] })))
  expect(store.getSnapshot()).toBe(committed)
  expect(() => fixture.rerender({ fail: true })).toThrow('abandoned render')
  expect(store.getSnapshot()).toBe(committed)
  fixture.unmount()
  expect(read).not.toHaveBeenCalled()
})

it.each([1000, 10000])('addresses one input without walking %i future retries', async (count) => {
  vi.useFakeTimers()
  const requests: string[][] = []
  let fresh = false
  const observer = new FileExplorerRepositoryObserver(
    async (request) => {
      requests.push(request.repositoryPaths!)
      return request.repositoryPaths!.map((path) => ({
        path,
        kind: fresh && path === 'folder0' ? 'absent' : 'unknown'
      }))
    },
    () => {}
  )
  observer.setFrontier(
    Array.from({ length: count }, (_, index) => ({ path: `folder${index}` })),
    []
  )
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(1000)
  requests.length = 0
  fresh = true
  let walked = 0
  const entries = Map.prototype.entries
  const countEntries = function* (this: Map<unknown, unknown>) {
    for (const [key, value] of entries.call(this)) {
      if (typeof key === 'string' && /^folder\d+/.test(key)) {
        walked++
      }
      yield [key, value] as [unknown, unknown]
    }
  }
  vi.spyOn(Map.prototype, 'values').mockImplementation(function* (this: Map<unknown, unknown>) {
    for (const [, value] of countEntries.call(this)) {
      yield value
    }
  })
  vi.spyOn(Map.prototype, 'keys').mockImplementation(function* (this: Map<unknown, unknown>) {
    for (const [key] of countEntries.call(this)) {
      yield key
    }
  })
  try {
    observer.invalidateChanges([{ path: 'folder0/.git', kind: 'create' }])
    await vi.advanceTimersByTimeAsync(4000)
    expect(requests).toEqual([['folder0']])
    expect(walked).toBe(0)
  } finally {
    vi.restoreAllMocks()
    observer.dispose()
  }
})

it.each([20, 200])(
  'does not visit %i sibling sources when one descendant listing changes',
  async (count) => {
    vi.useFakeTimers()
    supports.mockResolvedValue(true)
    read.mockImplementation(async (_route, request: GitRepositoryStatusRequest) => ({
      repositoryStatuses: request.repositoryPaths!.map((path) => ({
        path,
        kind: 'repository',
        status: { entries: [], conflictOperation: 'unknown' }
      }))
    }))
    const cache: Record<string, DirCache> = {
      '/w': { operationOwner: owner, children: [node('group', true)] },
      '/w/group': {
        operationOwner: owner,
        repositoryMarker: false,
        children: Array.from({ length: count }, (_, index) => node(`group/repo${index}`, true))
      }
    }
    for (let index = 0; index < count; index++) {
      cache[`/w/group/repo${index}`] = {
        operationOwner: owner,
        repositoryMarker: true,
        children: index === 0 ? [node('group/repo0/old.txt')] : []
      }
    }
    const store = new FileExplorerDirectoryCache()
    store.update(() => ({
      dirCache: cache,
      changedPaths: [],
      sourceWorkspaceId: 'folder:w',
      reset: true
    }))
    const expanded = new Set(['/w/group', '/w/group/repo0'])
    const fixture = renderHook(() =>
      useFileExplorerRepositories(
        'folder:w',
        '/w',
        '/w',
        { dirCacheStore: store },
        expanded,
        true,
        true
      )
    )
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(fixture.result.current.sources).toHaveLength(count)
    let visited = 0
    const entries = Map.prototype[Symbol.iterator]
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
      this: Map<unknown, unknown>
    ) {
      for (const pair of entries.call(this)) {
        if (typeof pair[0] === 'string' && /^(?:group\/)?repo\d+/.test(pair[0])) {
          visited++
        }
        yield pair
      }
    })
    act(() =>
      store.update((previous) => ({
        dirCache: {
          ...previous,
          '/w/group/repo0': {
            operationOwner: owner,
            repositoryMarker: true,
            children: [node('group/repo0/new.txt')]
          }
        },
        changedPaths: ['/w/group/repo0']
      }))
    )
    // Two direct dependency headers and one candidate, plus bounded retirement metadata.
    expect(visited).toBeLessThanOrEqual(10)
    expect(fixture.result.current.sources).toHaveLength(count)
    fixture.unmount()
  }
)

it('keeps unknown discovery backoff across repeated unreadable cache updates', async () => {
  vi.useFakeTimers()
  supports.mockResolvedValue(true)
  const probes: string[][] = []
  let recovered = false
  read.mockImplementation(async (_route, request: GitRepositoryStatusRequest) => {
    probes.push(request.repositoryPaths!)
    return { repositoryStatuses: [{ path: 'folder', kind: recovered ? 'absent' : 'unknown' }] }
  })
  const store = new FileExplorerDirectoryCache()
  store.update(() => ({
    dirCache: {
      '/w': { operationOwner: owner, children: [node('folder', true)] },
      '/w/folder': { operationOwner: owner, children: [], error: 'offline' }
    },
    changedPaths: [],
    sourceWorkspaceId: 'folder:w',
    reset: true
  }))
  const expanded = new Set<string>()
  const fixture = renderHook(() =>
    useFileExplorerRepositories(
      'folder:w',
      '/w',
      '/w',
      { dirCacheStore: store },
      expanded,
      true,
      true
    )
  )
  await act(() => vi.advanceTimersByTimeAsync(1000))
  for (let index = 0; index < 10; index++) {
    act(() =>
      store.update((previous) => ({
        dirCache: {
          ...previous,
          '/w/folder': { operationOwner: owner, children: [], error: `offline-${index}` }
        },
        changedPaths: ['/w/folder']
      }))
    )
    await act(() => vi.advanceTimersByTimeAsync(1000))
  }
  expect(probes).toEqual([['folder']])
  recovered = true
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(probes).toEqual([['folder'], ['folder']])
  fixture.unmount()
})
