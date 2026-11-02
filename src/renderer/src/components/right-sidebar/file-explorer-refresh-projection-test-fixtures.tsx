import { hasPropertyKey } from './file-explorer-expanded-refresh-test-support'
import type * as Module0 from 'react'
import { useCallback } from 'react'
import type * as Module1 from './use-file-explorer-directory-loads'
import type * as Module2 from './file-explorer-dir-load-tracker'
import type * as Module3 from './file-explorer-stale-dir-cache'
import type * as Module4 from './file-explorer-dir-load-state'
import type * as Module5 from './file-explorer-watch-path'
import type * as Module6 from './file-explorer-directory-listing'
import type { useFileExplorerDirectoryLoads } from './use-file-explorer-directory-loads'
import type { DirCache } from './file-explorer-types'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { cleanup } from '@testing-library/react'
import { afterEach, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'

const childListingCacheWork = vi.hoisted(() => ({
  wrap: (cache: Record<string, DirCache>) => cache
}))

const lifetimeWork = vi.hoisted(() => ({
  owners: Array<ReturnType<typeof useFileExplorerDirectoryLoads>>(),
  loadingOwners: new WeakMap<
    (...args: never[]) => unknown,
    ReturnType<typeof useFileExplorerDirectoryLoads>
  >(),
  measuring: false,
  beginning: false,
  copiedMembers: 0,
  allocations: 0,
  clearPaths: 0,
  updates: Array<{ owner: object; before: number; after: number; changed: boolean }>()
}))
vi.mock('react', async (original) => {
  const actual = await original<typeof Module0>()
  return {
    ...actual,
    useCallback: (callback: (...args: never[]) => unknown, deps: readonly unknown[]) => {
      const measured = vi.fn((...args: never[]) => {
        const owner = lifetimeWork.loadingOwners.get(measured)
        const count = lifetimeWork.measuring && owner !== undefined
        const before = owner?.loadingDirPathsRef.current
        const result = callback(...args)
        if (count && owner && before) {
          lifetimeWork.updates.push({
            owner: owner.dirLoadTrackerRef.current,
            before: before.size,
            after: owner.loadingDirPathsRef.current.size,
            changed: before !== owner.loadingDirPathsRef.current
          })
        }
        return result
      })
      return actual.useCallback(measured, deps)
    }
  }
})
vi.mock('./use-file-explorer-directory-loads', async (original) => {
  const actual = await original<typeof Module1>()
  return {
    ...actual,
    useFileExplorerDirectoryLoads: (
      ...args: Parameters<typeof actual.useFileExplorerDirectoryLoads>
    ) => {
      const owner = actual.useFileExplorerDirectoryLoads(...args)
      const storeDirCache = owner.setDirCache
      const setDirCache = useCallback<typeof storeDirCache>(
        (update) =>
          storeDirCache((prev) =>
            childListingCacheWork.wrap(typeof update === 'function' ? update(prev) : update)
          ),
        [storeDirCache]
      )
      lifetimeWork.owners[0] = owner
      lifetimeWork.loadingOwners.set(owner.updateLoadingDirPaths, owner)
      return { ...owner, setDirCache }
    }
  }
})
vi.mock('./file-explorer-dir-load-tracker', async (original) => {
  const actual = await original<typeof Module2>()
  return {
    ...actual,
    createFileExplorerDirLoadTracker: (
      ...args: Parameters<typeof actual.createFileExplorerDirLoadTracker>
    ) => {
      const tracker = actual.createFileExplorerDirLoadTracker(...args),
        begin = tracker.begin
      tracker.begin = (...values) => {
        lifetimeWork.beginning = true
        try {
          return begin(...values)
        } finally {
          lifetimeWork.beginning = false
        }
      }
      return tracker
    }
  }
})
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))

const loadingWork = vi.hoisted(() => ({ visits: 0, unionPaths: 0 }))
vi.mock('./file-explorer-stale-dir-cache', async (original) => {
  const actual = await original<typeof Module3>()
  return {
    ...actual,
    decideExpandedDirLoad: (...args: Parameters<typeof actual.decideExpandedDirLoad>) => {
      loadingWork.visits++
      return actual.decideExpandedDirLoad(...args)
    }
  }
})
vi.mock('./file-explorer-dir-load-state', async (original) => {
  const actual = await original<typeof Module4>()
  return {
    ...actual,
    clearFileExplorerDirsLoading: (prev: ReadonlySet<string>, paths: readonly string[]) => {
      if (!lifetimeWork.measuring) {
        return actual.clearFileExplorerDirsLoading(prev, paths)
      }
      lifetimeWork.clearPaths += paths.length
      const measured = new Proxy(prev, {
        get(target, key) {
          if (key === Symbol.iterator) {
            return function* () {
              for (const path of target) {
                lifetimeWork.copiedMembers++
                yield path
              }
            }
          }
          const value = hasPropertyKey(target, key) ? target[key] : undefined
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const next = actual.clearFileExplorerDirsLoading(measured, paths)
      if (next === measured) {
        return prev
      }
      lifetimeWork.allocations++
      return next
    },
    markFileExplorerDirsLoading: (
      ...args: Parameters<typeof actual.markFileExplorerDirsLoading>
    ) => {
      loadingWork.unionPaths += args[1].length
      return actual.markFileExplorerDirsLoading(...args)
    }
  }
})

const readDirectoryMock: Mock<typeof Module6.readFileExplorerDirectory> = vi.hoisted(() =>
  vi.fn<typeof Module6.readFileExplorerDirectory>()
)
const structuralWork = vi.hoisted(() => ({
  passes: 0,
  changedCaches: 0,
  parentLookups: 0,
  normalizedParents: 0,
  indexBuilds: 0,
  normalizedKeys: 0,
  measuring: false,
  wrapCache: (cache: Record<string, DirCache>) => cache,
  inReconcile: false,
  samples: Array<{
    rows: number
    keys: number
    failed: number
    changed: boolean
    reconcile: boolean
  }>()
}))
vi.mock('./file-explorer-watch-path', async (original) => {
  const actual = await original<typeof Module5>()
  return {
    ...actual,
    resolveCachedDirPath: (...args: Parameters<typeof actual.resolveCachedDirPath>) => {
      structuralWork.parentLookups++
      if (!(args[1] in args[0])) {
        structuralWork.normalizedParents++
      }
      return actual.resolveCachedDirPath(...args)
    },
    createCachedDirPathIndex: (
      cache: Parameters<typeof actual.createCachedDirPathIndex>[0],
      keys = Object.keys(cache)
    ) => {
      structuralWork.indexBuilds++
      structuralWork.normalizedKeys += keys.length
      return actual.createCachedDirPathIndex(cache, keys)
    }
  }
})
vi.mock('./file-explorer-directory-listing', async (original) => {
  const actual = await original<typeof Module6>()
  return {
    ...actual,
    readFileExplorerDirectory: readDirectoryMock,
    clearFailedOpenedDirectoryLinks: (
      ...args: Parameters<typeof actual.clearFailedOpenedDirectoryLinks>
    ) => {
      structuralWork.passes++
      let rows = 0,
        keys = 0
      const failedPaths = Array.from(args[1])
      const source = args[0]
      const parent = source['/repo']
      const measured =
        structuralWork.measuring && parent
          ? new Proxy(source, {
              get(target, key) {
                if (key === '/repo') {
                  return {
                    ...parent,
                    children: new Proxy(parent.children, {
                      get(children, index) {
                        if (typeof index === 'string' && /^\d+$/.test(index)) {
                          rows++
                        }
                        return hasPropertyKey(children, index) ? children[index] : undefined
                      }
                    })
                  }
                }
                return hasPropertyKey(target, key) ? target[key] : undefined
              },
              ownKeys(target) {
                const result = Reflect.ownKeys(target)
                keys += result.length
                return result
              }
            })
          : source
      const next = actual.clearFailedOpenedDirectoryLinks(measured, failedPaths)
      if (next !== measured) {
        structuralWork.changedCaches++
      }
      if (structuralWork.measuring) {
        structuralWork.samples.push({
          rows,
          keys,
          failed: failedPaths.length,
          changed: next !== measured,
          reconcile: structuralWork.inReconcile
        })
      }
      const result = next === measured ? source : next
      return structuralWork.measuring && !structuralWork.inReconcile
        ? structuralWork.wrapCache(result)
        : result
    }
  }
})
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' as const })
}))
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitIgnoredPaths: vi.fn().mockResolvedValue([])
}))

export const initialAppState = useAppStore.getInitialState()
export function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory } as DirEntry
}

export function listing(...entries: DirEntry[]) {
  return { entries, operationOwner: { kind: 'local' as const } }
}

afterEach(() => {
  childListingCacheWork.wrap = (cache) => cache
  lifetimeWork.measuring = false
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  cleanup()
  useAppStore.setState(initialAppState, true)
})

export { lifetimeWork, loadingWork, structuralWork, readDirectoryMock, childListingCacheWork }
