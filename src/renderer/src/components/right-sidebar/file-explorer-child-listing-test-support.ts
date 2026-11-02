import { measureFileExplorerChildIndexAllocations } from './file-explorer-child-index-allocation-test-support'
import { vi } from 'vitest'
import * as listingModule from './file-explorer-directory-listing'
import * as childModule from './file-explorer-child-listing'
import * as trackerModule from './file-explorer-dir-load-tracker'
import * as pathModule from './file-explorer-watch-path'
import * as runtimePaths from '../../../../shared/cross-platform-path'
import type { DirCache, TreeNode } from './file-explorer-types'
import { hasPropertyKey } from './file-explorer-expanded-refresh-test-support'
import {
  childListingCacheWork,
  lifetimeWork,
  loadingWork,
  structuralWork
} from './file-explorer-refresh-projection-test-fixtures'

/** Transparent counters on the actual published arrays; no query substitutes a row or permission. */
export function measureChildListings() {
  lifetimeWork.copiedMembers = lifetimeWork.allocations = lifetimeWork.clearPaths = 0
  lifetimeWork.updates = []
  loadingWork.visits = loadingWork.unionPaths = 0
  structuralWork.samples = []
  structuralWork.passes = structuralWork.changedCaches = 0
  structuralWork.parentLookups = structuralWork.normalizedParents = 0
  structuralWork.indexBuilds = structuralWork.normalizedKeys = 0
  const counts = {
    rowVisits: 0,
    pathReads: 0,
    symlinkReads: 0,
    admissionRows: 0,
    admissionPaths: 0,
    admissionSymlinks: 0,
    exactQueries: 0,
    normalizedQueries: 0,
    exactRows: 0,
    normalizedRows: 0,
    cacheGets: 0,
    parentDerivations: 0,
    normalizations: 0,
    facetNormalizations: 0,
    weakGets: 0,
    holders: 0,
    exactSets: 0,
    normalizedMaps: 0,
    facetArrays: 0,
    facetCopies: 0,
    facetTupleEntries: 0,
    exactQueryCharacters: 0,
    parentCharacters: 0,
    normalizedCharacters: 0,
    allSets: 0,
    allMaps: 0,
    allArrays: 0,
    allCopies: 0,
    conversions: 0,
    convertedEntries: 0,
    retentions: 0,
    retainedRows: 0,
    cacheEnumerations: 0,
    cacheEnumeratedKeys: 0,
    cacheValueReads: 0,
    finishes: 0,
    retirements: 0,
    owners: 0,
    resets: 0,
    cleanups: 0,
    physicalReads: 0,
    physicalSettled: 0,
    active: 0,
    peak: 0
  }
  let phase: 'idle' | 'admission' | 'exact' | 'normalized' = 'idle'
  const arrays = new WeakSet<readonly TreeNode[]>()
  const caches = new WeakMap<Record<string, DirCache>, Record<string, DirCache>>()
  childListingCacheWork.wrap = (cache) => {
    const prior = caches.get(cache)
    if (prior) {
      return prior
    }
    const measured = new Proxy(cache, {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target)
        counts.cacheEnumerations++
        counts.cacheEnumeratedKeys += keys.length
        return keys
      },
      get(target, key) {
        counts.cacheValueReads++
        return hasPropertyKey(target, key) ? target[key] : undefined
      }
    })
    caches.set(cache, measured)
    caches.set(measured, measured)
    return measured
  }
  const rows = new WeakSet<TreeNode>()
  const records: trackerModule.FileExplorerDirLoadToken[] = []
  const outcomes: string[] = []
  let queryChildren: readonly TreeNode[] | undefined
  const inPhase = <T>(next: typeof phase, operation: () => T, children = queryChildren): T => {
    const previous = phase,
      previousChildren = queryChildren
    phase = next
    queryChildren = children
    try {
      return operation()
    } finally {
      phase = previous
      queryChildren = previousChildren
    }
  }
  function observe(children: TreeNode[]): TreeNode[] {
    if (arrays.has(children)) {
      return children
    }
    arrays.add(children)
    children.forEach((child, index) => {
      Object.defineProperty(children, index, {
        configurable: true,
        enumerable: true,
        get: () => {
          counts.rowVisits++
          if (phase !== 'idle') {
            counts.admissionRows++
          }
          if (phase === 'exact') {
            counts.exactRows++
          }
          if (phase === 'normalized') {
            counts.normalizedRows++
          }
          return child
        }
      })
      if (rows.has(child)) {
        return
      }
      rows.add(child)
      const path = child.path,
        symlink = child.isSymlink
      Object.defineProperties(child, {
        path: {
          configurable: true,
          enumerable: true,
          get: () => {
            counts.pathReads++
            if (phase !== 'idle') {
              counts.admissionPaths++
            }
            return path
          }
        },
        isSymlink: {
          configurable: true,
          enumerable: true,
          get: () => {
            counts.symlinkReads++
            if (phase !== 'idle') {
              counts.admissionSymlinks++
            }
            return symlink
          }
        }
      })
    })
    return children
  }
  const convert = listingModule.fileExplorerEntriesToTreeNodes
  vi.spyOn(listingModule, 'fileExplorerEntriesToTreeNodes').mockImplementation((...args) => {
    counts.conversions++
    counts.convertedEntries += args[0].length
    return observe(convert(...args))
  })
  const retain = listingModule.keepOpenedDirectoryLinks
  vi.spyOn(listingModule, 'keepOpenedDirectoryLinks').mockImplementation((...args) => {
    counts.retentions++
    counts.retainedRows += args[0]?.length ?? 0
    return observe(retain(...args))
  })
  const follow = listingModule.canFollowFolderLink
  vi.spyOn(listingModule, 'canFollowFolderLink').mockImplementation((cache, path, gesture) =>
    inPhase('admission', () =>
      follow(
        new Proxy(cache, {
          get(target, key) {
            counts.cacheGets++
            return hasPropertyKey(target, key) ? target[key] : undefined
          }
        }),
        path,
        gesture
      )
    )
  )
  const exact = childModule.hasExactFileExplorerSymlink
  vi.spyOn(childModule, 'hasExactFileExplorerSymlink').mockImplementation((...args) => {
    counts.exactQueries++
    counts.exactQueryCharacters += args[1].length
    return inPhase('exact', () => exact(...args), args[0])
  })
  const normalized = childModule.findNormalizedFileExplorerChild
  vi.spyOn(childModule, 'findNormalizedFileExplorerChild').mockImplementation((...args) => {
    counts.normalizedQueries++
    return inPhase('normalized', () => normalized(...args), args[0])
  })
  const parent = pathModule.parentDirForWatchPath
  vi.spyOn(pathModule, 'parentDirForWatchPath').mockImplementation((...args) => {
    if (phase === 'admission') {
      counts.parentDerivations++
      counts.parentCharacters += args[0].length
    }
    return parent(...args)
  })
  const normalize = runtimePaths.normalizeRuntimePathForComparison
  vi.spyOn(runtimePaths, 'normalizeRuntimePathForComparison').mockImplementation((...args) => {
    counts.normalizations++
    counts.normalizedCharacters += args[0].length
    if (phase === 'normalized') {
      counts.facetNormalizations++
    }
    return normalize(...args)
  })
  const storage = measureFileExplorerChildIndexAllocations(
    counts,
    () => phase,
    () => queryChildren
  )
  const create = trackerModule.createFileExplorerDirLoadTracker
  vi.spyOn(trackerModule, 'createFileExplorerDirLoadTracker').mockImplementation((...args) => {
    counts.owners++
    const tracker = create(...args),
      begin = tracker.begin,
      finish = tracker.finish,
      retire = tracker.retire,
      reset = tracker.reset
    vi.spyOn(tracker, 'begin').mockImplementation((path, cleanup, flush) => {
      const token = begin(
        path,
        () => {
          counts.cleanups++
          cleanup?.()
        },
        flush
      )
      records.push(token)
      void token.promise.then((outcome) => {
        outcomes.push(outcome)
      })
      return token
    })
    vi.spyOn(tracker, 'finish').mockImplementation((...values) => {
      counts.finishes++
      return finish(...values)
    })
    vi.spyOn(tracker, 'retire').mockImplementation((...values) => {
      counts.retirements++
      return retire(...values)
    })
    vi.spyOn(tracker, 'reset').mockImplementation(() => {
      counts.resets++
      return reset()
    })
    return tracker
  })
  return {
    counts,
    observe,
    records,
    outcomes,
    storage,
    read: <T>(promise: Promise<T>): Promise<T> => {
      counts.physicalReads++
      counts.active++
      counts.peak = Math.max(counts.peak, counts.active)
      return promise.finally(() => {
        counts.active--
        counts.physicalSettled++
      })
    }
  }
}
