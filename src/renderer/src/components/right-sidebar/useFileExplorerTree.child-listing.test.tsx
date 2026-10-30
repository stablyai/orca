import { resetWorkspaceSwitchUserActsForTests } from '@/lib/workspace-switch-user-act'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
// @vitest-environment happy-dom
import {
  initialAppState,
  lifetimeWork,
  loadingWork,
  structuralWork,
  readDirectoryMock,
  listing
} from './file-explorer-refresh-projection-test-fixtures'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useVisibleTree,
  visibleProps,
  initializeExplorerSubscriptions,
  gateRead
} from './file-explorer-lifecycle-test-support'
import { measureChildListings } from './file-explorer-child-listing-test-support'
import { fileExplorerListingToDirCache } from './file-explorer-dir-pages'
import { flushWorkers } from './file-explorer-expanded-refresh-test-support'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'
import * as owners from './file-explorer-operation-owner'
import type { FileExplorerOperationOwner, DirCache } from './file-explorer-types'

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}
const routes: { owner: FileExplorerOperationOwner; cap: number }[] = [
  { owner: { kind: 'local' }, cap: 16 },
  {
    owner: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' },
    cap: 8
  },
  { owner: { kind: 'ssh', connectionId: 'ssh-a' }, cap: 4 }
]
beforeEach(() => {
  resetWorkspaceSwitchUserActsForTests()
  useAppStore.setState(initialAppState, true)
  initializeExplorerSubscriptions()
  readDirectoryMock.mockReset()
})
afterEach(() => {
  cleanup()
  lifetimeWork.measuring = false
  structuralWork.measuring = false
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(routes.flatMap((route) => [100, 1000].map((count) => ({ ...route, count }))))(
  'finishes all $count reentry children with one exact listing build at cap $cap',
  async ({ count, owner, cap }) => {
    // Arm before even the initial root conversion; counters never reset after upstream work.
    const measured = measureChildListings()
    lifetimeWork.measuring = true
    structuralWork.measuring = true
    vi.spyOn(owners, 'getFileExplorerOperationOwner').mockReturnValue(owner)
    const paths = Array.from({ length: count }, (_, index) => `/repo/d-${index}`)
    const rootListing = {
      ...listing(...paths.map((path) => entry(path.slice(6), true))),
      operationOwner: owner
    }
    const childListing = { ...listing(entry('fresh.txt')), operationOwner: owner }
    const root = gateRead(),
      pending = new Map<string, ReturnType<typeof gateRead>>()
    let reentry = false
    readDirectoryMock.mockImplementation((_id, _root, path: string) => {
      if (path === '/repo') {
        return measured.read(reentry ? root.promise : Promise.resolve(rootListing))
      }
      const gate = gateRead()
      pending.set(path, gate)
      return measured.read(gate.promise)
    })
    const reset = vi.fn(),
      filter = vi.fn()
    const hook = renderHook((props) => useVisibleTree(props, reset, filter, owner), {
      initialProps: visibleProps
    })
    await act(flushWorkers)
    act(() => {
      const retained: Record<string, DirCache> = { ...hook.result.current.dirCache }
      for (const path of paths) {
        retained[path] = fileExplorerListingToDirCache(childListing, path, 0, '/repo')
      }
      hook.result.current.setDirCache(retained)
      useAppStore.setState({ expandedDirs: { wt: new Set(paths) } })
    })
    await act(flushWorkers)
    expect(readDirectoryMock).toHaveBeenCalledTimes(1)
    reentry = true
    hook.rerender({ ...visibleProps, visible: false })
    hook.rerender(visibleProps)
    expect(readDirectoryMock).toHaveBeenCalledTimes(2)
    expect(hook.result.current.rootCache?.children).toHaveLength(count)
    await act(async () => {
      root.resolve(rootListing)
      await flushWorkers()
    })
    expect(pending.size).toBe(cap)
    for (let completed = 0; completed < count;) {
      const batch = [...pending.entries()]
      expect(batch.length).toBe(Math.min(cap, count - completed))
      batch.forEach(([path]) => pending.delete(path))
      await act(async () => {
        batch.forEach(([, gate]) => gate.resolve(childListing))
        await flushWorkers()
      })
      completed += batch.length
    }
    await act(async () => {
      await Promise.all(measured.records.map((token) => token.promise))
      await flushWorkers()
    })
    expect(readDirectoryMock).toHaveBeenCalledTimes(count + 2)
    expect(
      readDirectoryMock.mock.calls.slice(1).every((call) => call[3]?.wakeWslDistro !== true)
    ).toBe(true)
    expect(measured.counts.peak).toBe(cap)
    expect(measured.counts.physicalSettled).toBe(count + 2)
    expect(measured.counts.active).toBe(0)
    expect(measured.outcomes).toEqual(Array(count + 2).fill('refreshed'))
    expect(measured.records).toHaveLength(count + 2)
    expect(hook.result.current.loadingDirPaths.size).toBe(0)
    expect(paths.every((path) => !hook.result.current.isDirStale(path))).toBe(true)
    expect(
      paths.every(
        (path) => hook.result.current.dirCache[path].children[0].path === `${path}/fresh.txt`
      )
    ).toBe(true)
    // This is the meaningful old-source red: 10,000/1,000,000 instead of N admission visits.
    expect(measured.counts.admissionRows).toBe(count)
    expect(measured.counts.exactRows).toBe(count)
    expect(measured.counts.admissionSymlinks).toBe(count)
    expect(measured.counts.admissionPaths).toBe(0)
    expect(measured.counts.exactQueries).toBe(count)
    expect(measured.counts.exactSets).toBe(1)
    expect(measured.counts.holders).toBe(1)
    expect(measured.counts.normalizedMaps).toBe(0)
    expect(measured.counts.facetNormalizations).toBe(0)
    expect(measured.counts.facetArrays).toBe(0)
    expect(measured.counts.facetCopies).toBe(0)
    expect(measured.counts.facetTupleEntries).toBe(0)
    expect(measured.counts.exactQueryCharacters).toBe(
      paths.reduce((sum, path) => sum + path.length, 0)
    )
    expect(measured.counts.parentCharacters).toBe(
      paths.reduce((sum, path) => sum + path.length, 0) + 2 * '/repo'.length
    )
    expect(measured.storage()).toEqual({ exactEntries: 0, normalizedEntries: 0 })
    expect(measured.counts.cacheGets).toBe(2 * (count + 2))
    expect(measured.counts.parentDerivations).toBe(count + 2)
    expect(measured.counts.conversions).toBe(2 * count + 2)
    expect(measured.counts.convertedEntries).toBe(4 * count)
    expect(measured.counts.retainedRows).toBeGreaterThanOrEqual(2 * count)
    expect(loadingWork.visits).toBeGreaterThan(0)
    expect(structuralWork.samples.reduce((sum, sample) => sum + sample.rows, 0)).toBe(0)
    expect(lifetimeWork.updates.length).toBeGreaterThanOrEqual(count)
    expect(measured.counts.allMaps).toBeGreaterThan(0)
    expect(measured.counts.allSets).toBeGreaterThan(0)
    expect(measured.counts.allArrays).toBeGreaterThan(0)
    expect(measured.counts.weakGets).toBe(count)
    expect(measured.counts.finishes).toBe(count + 2)
    expect(measured.counts.cleanups).toBe(count + 2)
    expect(measured.counts.owners).toBe(1)
    const cacheRows = hook.result.current.rootCache!.children
    hook.rerender(visibleProps)
    await act(flushWorkers)
    expect(readDirectoryMock).toHaveBeenCalledTimes(count + 2)
    // A real watcher update uses the other facet, then its passive single read reuses exact evidence.
    const callbacks: Promise<unknown>[] = []
    act(() =>
      processFileExplorerFsPayload({
        payload: {
          worktreePath: '/repo',
          events: [{ kind: 'update', absolutePath: paths[0], isDirectory: true }]
        },
        currentWorktreePath: '/repo',
        worktreeId: 'wt',
        cache: { ...hook.result.current.dirCache },
        expanded: new Set(paths),
        setDirCache: hook.result.current.setDirCache,
        setSelectedPath: vi.fn(),
        refreshDir: (path) => {
          callbacks.push(hook.result.current.refreshDir(path))
        },
        refreshTree: () => {
          callbacks.push(hook.result.current.refreshTree())
        }
      })
    )
    expect(readDirectoryMock).toHaveBeenCalledTimes(count + 3)
    await act(async () => {
      pending.get(paths[0])!.resolve(childListing)
      await Promise.all(callbacks)
      await flushWorkers()
    })
    expect(hook.result.current.rootCache!.children).toBe(cacheRows)
    expect(measured.counts.exactSets).toBe(1)
    expect(measured.counts.holders).toBe(1)
    expect(measured.counts.normalizedMaps).toBe(1)
    expect(measured.counts.facetTupleEntries).toBe(0)
    expect(measured.counts.normalizedRows).toBe(count)
    expect(measured.counts.facetNormalizations).toBe(count + 1)
    expect(measured.counts.exactQueries).toBe(count + 1)
    expect(measured.storage()).toEqual({ exactEntries: 0, normalizedEntries: count })
    expect(measured.counts.active).toBe(0)
    expect(measured.outcomes).toHaveLength(count + 3)
    expect(hook.result.current.dirCache[paths[0]].children[0].name).toBe('fresh.txt')
    hook.unmount()
    expect(measured.counts.physicalReads).toBe(measured.counts.physicalSettled)
    expect(measured.counts.finishes).toBe(count + 3)
    expect(measured.counts.cleanups).toBe(count + 3)
    expect(measured.counts.retirements).toBe(0)
    expect(
      measured.records.every(
        (token) => lifetimeWork.owners[0].dirLoadTrackerRef.current.get(token.dirPath) === undefined
      )
    ).toBe(true)
    // Whole-interval work includes root construction, every actual updater (including no-ops),
    // all cache populations and the additional watch/single work; it is not a global linear claim.
    const P = count + 3,
      S = measured.counts.resets
    expect(lifetimeWork.updates.length).toBeLessThanOrEqual(4 * P + S)
    expect(lifetimeWork.clearPaths).toBeLessThanOrEqual(3 * P)
    expect(lifetimeWork.copiedMembers).toBeLessThanOrEqual(P * P)
    expect(measured.counts.cacheEnumeratedKeys).toBeLessThanOrEqual(
      measured.counts.cacheEnumerations * (count + 1)
    )
    expect(measured.counts.cacheEnumerations).toBeGreaterThan(0)
    expect(measured.counts.cacheValueReads).toBeGreaterThanOrEqual(count)
    expect(loadingWork.visits).toBeLessThanOrEqual((count + 1) * (4 * P + S + 20))
    expect(structuralWork.samples.every((sample) => sample.rows === 0 && sample.failed === 0)).toBe(
      true
    )
  }
)

it.each([false, true])(
  'reads queued parent replacement at dispatch in both orders: initially linked=%s',
  async (initiallyLinked) => {
    const measured = measureChildListings(),
      owner = routes[0].owner
    const blockers = Array.from({ length: 16 }, (_, index) => `held-${index}`)
    const names = [...blockers, 'first', 'second']
    const rootListing = listing(...names.map((name) => entry(name, true)))
    const held = new Map<string, ReturnType<typeof gateRead>>()
    readDirectoryMock.mockImplementation((_id, _root, path: string) => {
      if (path === '/repo') {
        return Promise.resolve(rootListing)
      }
      const gate = gateRead()
      held.set(path, gate)
      return measured.read(gate.promise)
    })
    const reset = vi.fn(),
      filter = vi.fn()
    const hook = renderHook((props) => useVisibleTree(props, reset, filter, owner), {
      initialProps: visibleProps
    })
    await act(flushWorkers)
    act(() =>
      useAppStore.setState({ expandedDirs: { wt: new Set(names.map((name) => `/repo/${name}`)) } })
    )
    expect(held.size).toBe(16)
    const replace = (linked: boolean) =>
      act(() =>
        hook.result.current.setDirCache((cache) => ({
          ...cache,
          '/repo': {
            ...cache['/repo'],
            children: measured.observe(
              cache['/repo'].children.map((child) =>
                child.name === 'first' || child.name === 'second'
                  ? { ...child, isSymlink: linked }
                  : child
              )
            )
          }
        }))
      )
    replace(initiallyLinked)
    await act(async () => {
      held.get('/repo/held-0')!.resolve(listing(entry('done.txt')))
      await flushWorkers()
    })
    expect(
      readDirectoryMock.mock.calls.find((call) => call[2] === '/repo/first')?.[3]
        ?.followProjectFolderLink
    ).toBe(initiallyLinked ? true : undefined)
    replace(!initiallyLinked)
    await act(async () => {
      held.get('/repo/held-1')!.resolve(listing(entry('done.txt')))
      await flushWorkers()
    })
    expect(
      readDirectoryMock.mock.calls.find((call) => call[2] === '/repo/second')?.[3]
        ?.followProjectFolderLink
    ).toBe(initiallyLinked ? undefined : true)
    await act(async () => {
      for (const gate of held.values()) {
        gate.resolve(listing(entry('done.txt')))
      }
      await flushWorkers()
      await Promise.all(measured.records.map((token) => token.promise))
    })
    expect(readDirectoryMock).toHaveBeenCalledTimes(19)
    expect(hook.result.current.loadingDirPaths.size).toBe(0)
    expect(hook.result.current.dirCache['/repo/first'].children[0].name).toBe('done.txt')
    expect(hook.result.current.dirCache['/repo/second'].children[0].name).toBe('done.txt')
    expect(measured.counts.exactSets).toBe(3)
    expect(measured.counts.holders).toBe(3)
    expect(measured.counts.peak).toBe(16)
    expect(measured.counts.active).toBe(0)
  }
)

it('keeps exact existential permission separate from aliases and reads same-array outside flags live', async () => {
  const measured = measureChildListings()
  readDirectoryMock.mockResolvedValue(listing(entry('content.txt')))
  const reset = vi.fn(),
    filter = vi.fn()
  const hook = renderHook((props) => useVisibleTree(props, reset, filter, routes[0].owner), {
    initialProps: visibleProps
  })
  await act(flushWorkers)
  const node = (path: string, isSymlink: boolean) => ({
    path,
    name: path,
    relativePath: path,
    isDirectory: true,
    isSymlink,
    depth: 0
  })
  const cases = [
    {
      parent: '/repo',
      path: '/repo/link',
      rows: [node('/repo/link', true), node('/repo/link', false)],
      follow: true
    },
    {
      parent: '/repo',
      path: '/repo/link',
      rows: [node('/repo/link', false), node('/repo/link', true)],
      follow: true
    },
    { parent: '/repo', path: '/repo/LINK', rows: [node('/repo/link', true)], follow: false },
    {
      parent: 'C:/Repo',
      path: 'C:/Repo/link',
      rows: [node('C:\\Repo\\link', true)],
      follow: false
    },
    { parent: 'c:/repo', path: 'C:/Repo/link', rows: [node('C:/Repo/link', true)], follow: false },
    { parent: '/repo', path: '/repo/link', rows: [node('/repo/link', false)], follow: false }
  ]
  for (const input of cases) {
    act(() =>
      hook.result.current.setDirCache({
        '/repo': { children: [] },
        [input.parent]: { children: measured.observe(input.rows) }
      })
    )
    await act(async () => {
      await hook.result.current.refreshDir(input.path)
      await flushWorkers()
    })
    expect(readDirectoryMock.mock.lastCall?.[3]?.followProjectFolderLink).toBe(
      input.follow ? true : undefined
    )
    expect(hook.result.current.dirCache[input.path].children[0].name).toBe('content.txt')
  }
  const children = measured.observe([node('/repo/live', false)])
  act(() => hook.result.current.setDirCache({ '/repo': { children } }))
  await act(async () => {
    await hook.result.current.refreshDir('/repo/live')
  })
  const builds = measured.counts.exactSets,
    queries = measured.counts.exactQueries
  act(() =>
    hook.result.current.setDirCache((cache) => ({
      ...cache,
      '/repo/live': { ...cache['/repo/live'], outsideProject: true }
    }))
  )
  await act(async () => {
    await hook.result.current.refreshDir('/repo/live')
  })
  expect(readDirectoryMock.mock.lastCall?.[3]?.followProjectFolderLink).toBe(true)
  act(() =>
    hook.result.current.setDirCache((cache) => ({
      ...cache,
      '/repo/live': { ...cache['/repo/live'], outsideProject: undefined },
      '/repo': { children, outsideProject: true }
    }))
  )
  await act(async () => {
    await hook.result.current.refreshDir('/repo/live')
  })
  expect(readDirectoryMock.mock.lastCall?.[3]?.followProjectFolderLink).toBe(true)
  expect(measured.counts.exactQueries).toBe(queries)
  act(() => hook.result.current.setDirCache((cache) => ({ ...cache, '/repo': { children } })))
  await act(async () => {
    await hook.result.current.refreshDir('/repo/live')
  })
  expect(readDirectoryMock.mock.lastCall?.[3]?.followProjectFolderLink).toBeUndefined()
  expect(measured.counts.exactQueries).toBe(queries + 1)
  expect(measured.counts.exactSets).toBe(builds)
  expect(hook.result.current.rootCache!.children).toBe(children)
  readDirectoryMock.mockRejectedValueOnce(new Error('a terminal attempt'))
  await act(async () => {
    await hook.result.current.refreshDir('/repo/live')
  })
  expect(hook.result.current.dirCache['/repo/live'].error).toBe('a terminal attempt')
  const rowsBeforeGesture = measured.counts.admissionRows
  const queriesBeforeGesture = measured.counts.exactQueries
  act(() => hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0]))
  await act(flushWorkers)
  expect(readDirectoryMock.mock.lastCall?.[3]).toMatchObject({
    followProjectFolderLink: true,
    wakeWslDistro: true
  })
  expect(measured.counts.admissionRows).toBe(rowsBeforeGesture)
  expect(measured.counts.exactQueries).toBe(queriesBeforeGesture)
  expect(hook.result.current.dirCache['/repo/live'].error).toBeUndefined()
})

it.each([false, true])(
  'shares lazy facets across real owners with watcher first=%s',
  async (watcherFirst) => {
    const measured = measureChildListings()
    readDirectoryMock.mockResolvedValue(listing(entry('d', true)))
    const reset = vi.fn(),
      filter = vi.fn()
    const first = renderHook(() => useVisibleTree(visibleProps, reset, filter, routes[0].owner))
    const second = renderHook(() => useVisibleTree(visibleProps, reset, filter, routes[0].owner))
    await act(flushWorkers)
    const children = measured.observe(first.result.current.rootCache!.children)
    act(() => {
      first.result.current.setDirCache({ '/repo': { children } })
      second.result.current.setDirCache({ '/repo': { children } })
    })
    const watch = () =>
      processFileExplorerFsPayload({
        payload: {
          worktreePath: '/repo',
          events: [{ kind: 'update', absolutePath: '/repo/d', isDirectory: true }]
        },
        currentWorktreePath: '/repo',
        worktreeId: 'wt',
        cache: first.result.current.dirCache,
        expanded: new Set(),
        setDirCache: first.result.current.setDirCache,
        setSelectedPath: vi.fn(),
        refreshDir: vi.fn(),
        refreshTree: vi.fn()
      })
    if (watcherFirst) {
      act(watch)
      expect(measured.counts.exactSets).toBe(0)
      expect(measured.counts.normalizedMaps).toBe(1)
    }
    await act(async () => {
      await first.result.current.refreshDir('/repo/d')
      await second.result.current.refreshDir('/repo/d')
      await flushWorkers()
    })
    if (!watcherFirst) {
      expect(measured.counts.normalizedMaps).toBe(0)
      act(watch)
    }
    expect(measured.counts.owners).toBe(2)
    expect(measured.counts.holders).toBe(1)
    expect(measured.counts.exactSets).toBe(1)
    expect(measured.counts.normalizedMaps).toBe(1)
    expect(measured.counts.exactRows).toBe(1)
    expect(measured.counts.normalizedRows).toBe(1)
    expect(measured.counts.exactQueries).toBe(2)
    expect(measured.storage()).toEqual({ exactEntries: 0, normalizedEntries: 1 })
    expect(first.result.current.rootCache!.children).toBe(children)
    expect(second.result.current.rootCache!.children).toBe(children)
    expect(first.result.current.dirCache['/repo/d'].children[0].name).toBe('d')
    expect(second.result.current.dirCache['/repo/d'].children[0].name).toBe('d')
    await Promise.all(measured.records.map((token) => token.promise))
    first.unmount()
    second.unmount()
  }
)
