// @vitest-environment happy-dom
import {
  loadingWork,
  structuralWork,
  readDirectoryMock,
  initialAppState,
  entry,
  listing
} from './file-explorer-refresh-projection-test-fixtures'
import { hasPropertyKey } from './file-explorer-expanded-refresh-test-support'
import { useCallback } from 'react'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DirCache } from './file-explorer-types'
import { FileExplorerRow } from './FileExplorerRow'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { directoryNode } from './file-explorer-tree-node-test-fixtures'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import {
  gateRead,
  useVisibleTree,
  visibleProps,
  initializeExplorerSubscriptions
} from './file-explorer-lifecycle-test-support'

const WORKTREE_PATH = '/repo'
const SRC_DIR = '/repo/src'

function useTreeWithProjection(expanded: Set<string>) {
  const tree = useFileExplorerTree(WORKTREE_PATH, expanded, 'wt-1')
  const projection = useFileExplorerVisibleRowProjection(
    'wt-1',
    WORKTREE_PATH,
    tree.dirCache,
    expanded,
    false,
    true,
    null
  )
  return { tree, rowProjection: projection.rowProjection }
}

function renderTreeWithProjectionRebuildCounter(expanded: Set<string>): {
  result: { current: ReturnType<typeof useTreeWithProjection> }
  rebuilds: () => number
} {
  const seen = new Set<unknown>()
  const hook = renderHook(() => {
    const value = useTreeWithProjection(expanded)
    seen.add(value.rowProjection)
    return value
  })
  return { result: hook.result, rebuilds: () => seen.size }
}

/** Holds the next directory read open so the loading commit lands in its own render. */
function gateNextRead(): { resolve: (value: ReturnType<typeof listing>) => void } {
  let resolve!: (value: ReturnType<typeof listing>) => void
  const gate = new Promise<ReturnType<typeof listing>>((nextResolve) => {
    resolve = nextResolve
  })
  readDirectoryMock.mockImplementationOnce(() => gate)
  return { resolve }
}

function findFileExplorerRow(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (candidate) => {
    if (candidate.type === FileExplorerRow) {
      found = candidate
    }
  })
  if (!found) {
    throw new Error('file explorer row not found')
  }
  return found
}

describe('file explorer directory refresh churn', () => {
  beforeEach(() => {
    readDirectoryMock.mockReset().mockResolvedValue(listing())
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  it('does not stack a second read on an expanded dir the loading set already owns', async () => {
    initializeExplorerSubscriptions()
    const reset = vi.fn(),
      filter = vi.fn()
    readDirectoryMock.mockResolvedValueOnce(listing(entry('src', true)))
    const hook = renderHook(() =>
      useVisibleTree({ ...visibleProps, id: 'wt-1' }, reset, filter, { kind: 'local' })
    )
    await act(async () => {
      await Promise.resolve()
    })
    const held = gateRead()
    readDirectoryMock.mockClear().mockReturnValueOnce(held.promise)
    act(() => hook.result.current.toggleDir('wt-1', SRC_DIR))
    expect(readDirectoryMock).toHaveBeenCalledTimes(1)
    expect(hook.result.current.loadingDirPaths.has(SRC_DIR)).toBe(true)
    hook.rerender()
    expect(readDirectoryMock).toHaveBeenCalledTimes(1)
    await act(async () => held.resolve(listing(entry('current.ts'))))
    expect(hook.result.current.dirCache[SRC_DIR].children[0].name).toBe('current.ts')
    expect(hook.result.current.loadingDirPaths.has(SRC_DIR)).toBe(false)
    hook.rerender()
    expect(readDirectoryMock).toHaveBeenCalledTimes(1)
    expect(readDirectoryMock.mock.calls[0][3]?.wakeWslDistro).toBe(true)
    vi.unstubAllGlobals()
  })

  it.each([100, 1000])(
    'does no loading scan/union work on unrelated renders at %i expanded directories',
    async (count) => {
      const paths = Array.from({ length: count }, (_, index) => `/repo/dir-${index}`)
      const expanded = new Set(paths)
      const hook = renderHook(({ dirs }) => useFileExplorerTree(WORKTREE_PATH, dirs, 'wt-1'), {
        initialProps: { dirs: expanded }
      })
      await act(async () => {
        hook.result.current.setDirCache(
          Object.fromEntries(
            paths.map((path) => [
              path,
              { children: [], operationOwner: { kind: 'local' as const } }
            ])
          )
        )
      })
      const root = gateRead()
      readDirectoryMock.mockReturnValueOnce(root.promise)
      let refresh!: ReturnType<typeof hook.result.current.refreshTree>
      act(() => {
        refresh = hook.result.current.refreshTree()
      })
      expect(paths.every((path) => hook.result.current.loadingDirPaths.has(path))).toBe(true)
      for (const phase of ['held-root', 'settled']) {
        loadingWork.visits = 0
        loadingWork.unionPaths = 0
        for (let index = 0; index < 3; index++) {
          // Separate consumer turns, with all directory inputs kept identical.
          await act(async () => hook.rerender({ dirs: expanded }))
        }
        expect({ phase, ...loadingWork }).toEqual({ phase, visits: 0, unionPaths: 0 })
        if (phase === 'held-root') {
          await act(async () => {
            root.resolve({
              entries: [],
              operationOwner: {
                kind: 'runtime',
                environmentId: 'host-a',
                executionHostId: 'runtime:host-a'
              }
            })
            await refresh
          })
        }
      }
      expect(hook.result.current.loadingDirPaths.size).toBe(0)
      loadingWork.visits = 0
      const added = '/repo/new-demand'
      hook.rerender({ dirs: new Set([...expanded, added]) })
      expect(hook.result.current.loadingDirPaths.has(added)).toBe(true)
      expect(loadingWork.visits).toBe(count + 1)
      const read = gateRead()
      readDirectoryMock.mockReturnValueOnce(read.promise)
      let pending!: Promise<void>
      act(() => {
        pending = hook.result.current.refreshDir(added)
      })
      expect(hook.result.current.loadingDirPaths.has(added)).toBe(true)
      await act(async () => {
        read.resolve({
          entries: [],
          operationOwner: {
            kind: 'runtime',
            environmentId: 'host-a',
            executionHostId: 'runtime:host-a'
          }
        })
        await pending
      })
      expect(hook.result.current.loadingDirPaths.has(added)).toBe(false)
      act(() => hook.result.current.reconcileView(expanded, () => false, null))
      const readsBeforeInvalidation = readDirectoryMock.mock.calls.length
      await act(async () => {
        await hook.result.current.refreshDir(paths[0])
      })
      expect(readDirectoryMock).toHaveBeenCalledTimes(readsBeforeInvalidation)
      expect(hook.result.current.loadingDirPaths.has(paths[0])).toBe(true)
    }
  )

  it('rebuilds the visible row projection once per touched-directory refresh', async () => {
    const expanded = new Set([SRC_DIR])
    readDirectoryMock.mockResolvedValue(listing(entry('index.ts')))
    const { result, rebuilds } = renderTreeWithProjectionRebuildCounter(expanded)

    await act(async () => {
      await result.current.tree.loadDir(WORKTREE_PATH, -1, { force: true })
    })
    await act(async () => {
      await result.current.tree.loadDir(SRC_DIR, 0, { force: true })
    })
    const rebuildsBeforeRefresh = rebuilds()

    // Gate the refresh so loading commits before the new listing.
    const gatedRead = gateNextRead()
    let pendingRefresh!: Promise<void>
    await act(async () => {
      pendingRefresh = result.current.tree.refreshDir(SRC_DIR)
      await Promise.resolve()
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(true)
    // Loading must not replace identical dirCache rows and pay for a second full projection walk.
    expect(rebuilds()).toBe(rebuildsBeforeRefresh)

    await act(async () => {
      gatedRead.resolve(listing(entry('index.ts')))
      await pendingRefresh
    })
    expect(rebuilds() - rebuildsBeforeRefresh).toBe(1)
  })

  it('keeps the directory marked loading for the whole of a slow read', async () => {
    const expanded = new Set([SRC_DIR])
    const gatedRead = gateNextRead()
    const { result, rebuilds } = renderTreeWithProjectionRebuildCounter(expanded)

    let pendingLoad!: Promise<boolean>
    await act(async () => {
      pendingLoad = result.current.tree.loadDir(SRC_DIR, 0)
      await Promise.resolve()
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(true)
    const rebuildsWhileLoading = rebuilds()

    await act(async () => {
      gatedRead.resolve(listing(entry('index.ts')))
      await pendingLoad
    })
    expect(result.current.tree.loadingDirPaths.has(SRC_DIR)).toBe(false)
    expect(result.current.tree.dirCache[SRC_DIR].children).toHaveLength(1)
    expect(rebuilds()).toBe(rebuildsWhileLoading + 1)
  })

  it('renders the folder spinner from the loading dir set', () => {
    const rowProps = {
      virtualizer: {
        getTotalSize: () => 26,
        getVirtualItems: () => [{ index: 0, key: 'src', start: 0 }],
        measureElement: vi.fn()
      } as never,
      inlineInputIndex: -1,
      rowProjection: createFileExplorerRowProjection([directoryNode]),
      inlineInput: null,
      handleInlineSubmit: vi.fn(),
      dismissInlineInput: vi.fn(),
      folderStatusByRelativePath: new Map(),
      statusByRelativePath: new Map(),
      ignoredByRelativePath: new Set<string>(),
      expanded: new Set([directoryNode.path]),
      selectedPaths: new Set<string>(),
      activeFileId: null,
      flashingPath: null,
      deleteShortcutLabel: 'Del',
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onViewFile: vi.fn(),
      onContextMenuSelect: vi.fn(),
      onCopyPaths: vi.fn(),
      onStartNew: vi.fn(),
      onStartRename: vi.fn(),
      onDuplicate: vi.fn(),
      onAddFolderAsProject: vi.fn(),
      canAddFolderAsProject: () => false,
      onOpenInTerminal: vi.fn(),
      onRequestDelete: vi.fn(),
      onCollapseFolderSubtree: vi.fn(),
      onFindInFolder: vi.fn(),
      onMoveDrop: vi.fn(),
      onDragTargetChange: vi.fn(),
      onDragSourceChange: vi.fn(),
      onDragExpandDir: vi.fn(),
      onNativeDragTargetChange: vi.fn(),
      onNativeDragExpandDir: vi.fn(),
      dropTargetDir: null,
      dragSourcePath: null,
      nativeDropTargetDir: null
    }

    const loading = FileExplorerVirtualRows({
      ...rowProps,
      loadingDirPaths: new Set([directoryNode.path])
    })
    const idle = FileExplorerVirtualRows({ ...rowProps, loadingDirPaths: new Set<string>() })

    expect(findFileExplorerRow(loading).props.isLoading).toBe(true)
    expect(findFileExplorerRow(idle).props.isLoading).toBe(false)
  })

  it.each([100, 1000])(
    'bounds failed-parent row/key/copy work per real reconcile at %i siblings',
    async (count) => {
      const paths = Array.from({ length: count }, (_, i) => `/repo/d${i}`)
      const expanded = new Set(paths)
      const hook = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt-1'))
      readDirectoryMock.mockImplementation((_id, _root, path) =>
        path === '/repo'
          ? Promise.resolve(listing(...paths.map((path) => entry(path.slice(6), true))))
          : Promise.reject(new Error('denied'))
      )
      await act(async () => {
        await hook.result.current.refreshTree()
      })
      expect(paths.every((path) => hook.result.current.dirCache[path].error === 'denied')).toBe(
        true
      )
      const cache = hook.result.current.dirCache
      const children = cache['/repo'].children
      act(() => hook.result.current.retireView())
      // Inferred links demote once; host-confirmed directories retain their shape.
      const inferred = children.map((node, i) => ({
        ...node,
        isSymlink: true,
        isDirectoryFromOpenedLink: i % 2 === 0
      }))
      let copyReads = 0
      const measured = new Proxy(inferred, {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            copyReads++
          }
          return hasPropertyKey(target, key) ? target[key] : undefined
        }
      })
      let copyKeys = 0
      const inferredCache = new Proxy(
        {
          ...cache,
          '/repo': { ...cache['/repo'], children: measured }
        },
        {
          ownKeys(target) {
            const result = Reflect.ownKeys(target)
            copyKeys += result.length
            return result
          }
        }
      )
      act(() => hook.result.current.setDirCache(inferredCache))
      for (const key of [
        'passes',
        'changedCaches',
        'parentLookups',
        'normalizedParents',
        'indexBuilds',
        'normalizedKeys'
      ]) {
        Reflect.set(structuralWork, key, 0)
      }
      act(() => hook.result.current.reconcileView(expanded, () => true, null))
      expect(copyReads).toBe(count * 2)
      // One error-population enumeration and one lazy outer copy, independently of publication identity.
      expect(copyKeys).toBe((count + 1) * 2)
      expect(structuralWork.changedCaches).toBe(1)
      expect(
        hook.result.current.dirCache['/repo'].children.every(
          (node, i) => node.isDirectory === (i % 2 !== 0)
        )
      ).toBe(true)
      const demoted = hook.result.current.dirCache
      act(() => hook.result.current.reconcileView(expanded, () => true, null))
      expect(hook.result.current.dirCache).toBe(demoted)
      expect(structuralWork.changedCaches).toBe(1)
      act(() => hook.result.current.retireView())
    }
  )

  it('reconciles canonical parents once, preserves exact targets, and ignores absent parents', () => {
    const hook = renderHook(() => useFileExplorerTree('/repo', new Set<string>(), 'wt-1'))
    const node = (path: string) => ({
      name: 'link',
      path,
      relativePath: 'link',
      depth: 0,
      isDirectory: true,
      isSymlink: true,
      isDirectoryFromOpenedLink: true
    })
    act(() =>
      hook.result.current.setDirCache({
        '/repo': { children: [], operationOwner: { kind: 'local' } },
        'C:\\Repo': { children: [node('c:\\repo\\link'), node('C:\\Repo\\other')] },
        'c:\\repo\\link': { children: [], error: '' },
        'c:\\repo\\OTHER': { children: [], error: 'denied' },
        '/absent/link': { children: [], error: 'denied' }
      })
    )
    for (const key of [
      'passes',
      'changedCaches',
      'parentLookups',
      'normalizedParents',
      'indexBuilds',
      'normalizedKeys'
    ]) {
      Reflect.set(structuralWork, key, 0)
    }
    act(() => hook.result.current.reconcileView(new Set(), () => true, null))
    expect(hook.result.current.dirCache['C:\\Repo'].children.map((row) => row.isDirectory)).toEqual(
      [false, true]
    )
    expect(structuralWork).toMatchObject({
      indexBuilds: 1,
      normalizedKeys: 5,
      normalizedParents: 3,
      changedCaches: 1
    })
  })
})

it.each([100, 1000])(
  'counts whole failing Wave and genuine effect passes from first failure at %i siblings',
  async (count) => {
    useAppStore.setState(initialAppState, true)
    readDirectoryMock.mockReset()
    const paths = Array.from({ length: count }, (_, i) => `/repo/d${i}`)
    const expanded = new Set(paths),
      gates = paths.map(() => gateRead())
    const root = listing(...paths.map((path) => entry(path.slice(6), true)))
    const rootGate = gateRead()
    let rootReads = 0,
      reconciles = 0,
      upstreamKeys = 0,
      cacheEnumerations = 0,
      cacheKeyVisits = 0,
      indexedEnumerations = 0,
      indexedKeys = 0
    const proxies = new WeakSet<object>()
    const measureCache = (cache: Record<string, DirCache>): Record<string, DirCache> => {
      if (proxies.has(cache)) {
        return cache
      }
      const measured = new Proxy(cache, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target)
          cacheEnumerations++
          cacheKeyVisits += keys.length
          return keys
        }
      })
      proxies.add(measured)
      return measured
    }
    structuralWork.wrapCache = measureCache
    readDirectoryMock.mockImplementation((_id, _root, path) =>
      path === '/repo'
        ? ++rootReads === 1
          ? Promise.resolve(root)
          : rootGate.promise
        : gates[paths.indexOf(path)].promise
    )
    structuralWork.measuring = true
    structuralWork.samples = []
    structuralWork.indexBuilds = structuralWork.normalizedKeys = 0
    const objectKeys = Object.keys
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation((object) => {
      const keys = objectKeys(object)
      if (Object.hasOwn(object, '/repo')) {
        upstreamKeys += keys.length
      }
      if (proxies.has(object)) {
        indexedEnumerations++
        indexedKeys += keys.length
      }
      return keys
    })
    const reset = vi.fn(),
      filter = vi.fn()
    const hook = renderHook(
      ({ scope, blocked }) => {
        const tree = useFileExplorerTree('/repo', expanded, 'wt-1', scope)
        const { reconcileView: reconcile } = tree
        const reconcileView = useCallback(
          (...args: Parameters<typeof reconcile>) => {
            reconciles++
            structuralWork.inReconcile = true
            try {
              reconcile(...args)
            } finally {
              structuralWork.inReconcile = false
            }
          },
          [reconcile]
        )
        useFileExplorerTreeLoadEffects({
          workspaceKey: null,
          visibleFilesWorktreePath: '/repo',
          activeWorktreeId: 'wt-1',
          displayRootPath: scope,
          expanded,
          dirCache: tree.dirCache,
          loadingDirPaths: tree.loadingDirPaths,
          rootError: tree.rootError,
          invalidateTree: tree.invalidateTree,
          retireView: tree.retireView,
          reconcileView,
          loadRevision: tree.loadRevision,
          interactionBlocked: blocked,
          resetAndLoad: tree.resetAndLoad,
          resetSelection: reset,
          setNameFilterQuery: filter
        })
        return tree
      },
      { initialProps: { scope: '/repo', blocked: false } }
    )
    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(readDirectoryMock.mock.calls.filter((call) => call[2] !== '/repo')).toHaveLength(16)
      // Install ownKeys observation on the actual owner before its first failure; each real Wave publication retains it.
      act(() => hook.result.current.setDirCache(measureCache))
      for (let start = 0; start < count; start += 16) {
        const before = reconciles
        await act(async () => {
          gates.slice(start, start + 16).forEach((gate) => gate.reject(new Error('denied')))
          await Promise.resolve()
          await Promise.resolve()
        })
        // Cache and loading publications can each render; satisfied terminal demand introduces no further update.
        expect(reconciles - before).toBeLessThanOrEqual(2)
      }
      expect(paths.every((path) => hook.result.current.dirCache[path].error === 'denied')).toBe(
        true
      )
      const batches = structuralWork.samples.filter(
        (sample) => !sample.reconcile && sample.failed > 0
      )
      const releasePasses = structuralWork.samples.filter((sample) => sample.reconcile)
      expect(batches).toHaveLength(Math.ceil(count / 16))
      expect(batches.reduce((sum, sample) => sum + sample.failed, 0)).toBe(count)
      expect(releasePasses.length).toBeLessThanOrEqual(2 * batches.length + 5) // initial reset/claim/root-release and instrumentation publication + result turns
      const settledReconciles = reconciles
      hook.rerender({ scope: paths[0], blocked: false })
      hook.rerender({ scope: paths[0], blocked: true })
      act(() => {
        void hook.result.current.refreshDir('/repo')
      })
      expect(rootReads).toBe(1) // parked precise invalidation, no hidden admission
      hook.rerender({ scope: '/repo', blocked: false })
      await act(async () => rootGate.resolve(root))
      expect(rootReads).toBe(2)
      expect(reconciles - settledReconciles).toBeLessThanOrEqual(7) // scope, protect, invalidation, release, cache/loading, root notification
      expect(readDirectoryMock).toHaveBeenCalledTimes(count + 2)
      const samples = structuralWork.samples
      // Each actual helper pass scans its affected parent once, does no canonical fallback/copy for ordinary dirs.
      samples.forEach((sample) => {
        expect(sample.rows).toBe(sample.failed ? count : 0)
        expect(sample.keys).toBe(0)
        expect(sample.changed).toBe(false)
      })
      const B = samples.filter((sample) => !sample.reconcile && sample.failed).length
      const Q = samples.filter((sample) => sample.reconcile && sample.failed).length
      expect(samples.reduce((sum, sample) => sum + sample.rows, 0)).toBe(count * (B + Q))
      expect(structuralWork.indexBuilds).toBe(0)
      expect(structuralWork.normalizedKeys).toBe(0)
      // ownKeys observes actual outer copies independently of Object.keys error-population walks.
      // B Wave spreads plus the final precise-root publication; reconcile's ordinary no-change has no copy.
      expect(cacheEnumerations - indexedEnumerations).toBe(B + 1)
      expect(cacheKeyVisits - indexedKeys).toBe((B + 1) * (count + 1))

      // Upstream historical error enumeration/invalidation is counted separately from helper rows and ownKeys.
      expect(upstreamKeys).toBeGreaterThanOrEqual(Q * (count + 1))
      expect(upstreamKeys).toBeLessThanOrEqual((reconciles + 2) * (count + 1))
      const stable = reconciles,
        sampleCount = samples.length
      hook.rerender({ scope: '/repo', blocked: false })
      expect(reconciles).toBe(stable)
      expect(samples).toHaveLength(sampleCount)
    } finally {
      hook.unmount()
      structuralWork.measuring = structuralWork.inReconcile = false
      structuralWork.wrapCache = (cache) => cache
      keysSpy.mockRestore()
      cleanup()
      useAppStore.setState(initialAppState, true)
    }
  }
)
