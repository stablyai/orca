import { vi } from 'vitest'
import * as placementReads from './web-session-tabs-sync/open-placement-read'
import * as snapshotPlacements from './web-session-tabs-sync/open-placement'
import * as frameSelections from './workspace-layout-frame-open-selection'
import * as mappings from './web-session-tabs-sync/tracking-mappings'
import { hostSessionTabIdByLocalKey } from './web-session-tabs-sync/state'
import * as selectionFingerprint from '../../../shared/structured-agent-session-mutation'

/** Count metadata work while delegating every read and final writer to production. */
export function countOpenPlacementWork() {
  type Pass = 'snapshot' | 'discovery' | 'writer'
  const reads: {
    pass: Pass
    worktreeId: string
    tabRows: number
    terminalRows: number
    snapshotRows: number
    mappingCopies: number
    mappingRows: number
    sourceChecks: number
    viewerChecks: number
    destinationLookups: number
  }[] = []
  const visits: { pass: Pass; worktreeId: string; rows: number }[] = []
  const builtKeys: string[][] = []
  let pass: Pass = 'snapshot'
  let indexing: (typeof reads)[number] | undefined
  let fingerprints = 0
  const restores: (() => void)[] = []
  const countedRows = <T>(rows: T[], visit: () => void): T[] =>
    new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          visit()
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, property, receiver)
      }
    })
  const countLayout = <T extends { worktreeId: string; tabs: unknown[] }>(layout: T): T => {
    const visit = { pass, worktreeId: layout.worktreeId, rows: 0 }
    visits.push(visit)
    return {
      ...layout,
      tabs: countedRows(layout.tabs, () => {
        if (!indexing) {
          visit.rows += 1
        }
      })
    }
  }
  const realMappingGet = hostSessionTabIdByLocalKey.get.bind(hostSessionTabIdByLocalKey)
  const mappingGet = vi.spyOn(hostSessionTabIdByLocalKey, 'get').mockImplementation((key) => {
    if (indexing) {
      indexing.mappingCopies += 1
    }
    return realMappingGet(key)
  })
  restores.push(() => mappingGet.mockRestore())
  const realMappings = mappings.hostSessionTabIdsByLocalTabForWorktree
  const mappingRead = vi
    .spyOn(mappings, 'hostSessionTabIdsByLocalTabForWorktree')
    .mockImplementation((...args) => {
      const rows = realMappings(...args)
      const reading = indexing
      if (reading) {
        const iterate = rows[Symbol.iterator].bind(rows)
        rows[Symbol.iterator] = function* () {
          for (const entry of iterate()) {
            reading.mappingRows += 1
            yield entry
          }
          return undefined
        }
      }
      return rows
    })
  restores.push(() => mappingRead.mockRestore())
  const realRead = placementReads.createOpenPlacementRead
  const read = vi
    .spyOn(placementReads, 'createOpenPlacementRead')
    .mockImplementation((state, worktreeId, owner, snapshot, now) => {
      const counts = {
        pass,
        worktreeId,
        tabRows: 0,
        terminalRows: 0,
        snapshotRows: 0,
        mappingCopies: 0,
        mappingRows: 0,
        sourceChecks: 0,
        viewerChecks: 0,
        destinationLookups: 0
      }
      reads.push(counts)
      const before = indexing
      indexing = counts
      let actual: ReturnType<typeof realRead>
      try {
        actual = realRead(
          {
            ...state,
            unifiedTabsByWorktree: {
              ...state.unifiedTabsByWorktree,
              [worktreeId]: countedRows(
                state.unifiedTabsByWorktree[worktreeId] ?? [],
                () => counts.tabRows++
              )
            },
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [worktreeId]: countedRows(
                state.tabsByWorktree[worktreeId] ?? [],
                () => counts.terminalRows++
              )
            }
          },
          worktreeId,
          owner,
          snapshot && {
            ...snapshot,
            tabs: countedRows(snapshot.tabs, () => counts.snapshotRows++)
          },
          now
        )
      } finally {
        indexing = before
      }
      return {
        ...actual,
        sourceCurrent: (...args) => {
          counts.sourceChecks++
          return actual.sourceCurrent(...args)
        },
        viewerSelectionCurrent: (...args) => {
          counts.viewerChecks++
          return actual.viewerSelectionCurrent(...args)
        },
        localTabId: (...args) => {
          counts.destinationLookups++
          return actual.localTabId(...args)
        }
      }
    })
  restores.push(() => read.mockRestore())
  const realSnapshot = snapshotPlacements.prepareSnapshotOpenPlacements
  const snapshot = vi
    .spyOn(snapshotPlacements, 'prepareSnapshotOpenPlacements')
    .mockImplementation((state, layout, ...rest) => {
      pass = 'snapshot'
      return realSnapshot(state, countLayout({ ...layout, worktreeId: layout.worktree }), ...rest)
    })
  restores.push(() => snapshot.mockRestore())
  const realDiscovery = frameSelections.frameOpenPlacements
  const discovery = vi
    .spyOn(frameSelections, 'frameOpenPlacements')
    .mockImplementation((state, layout, owner) => {
      pass = 'discovery'
      return realDiscovery(state, countLayout(layout), owner)
    })
  restores.push(() => discovery.mockRestore())
  const realWriter = frameSelections.frameOpenSelectionPatch
  const writer = vi
    .spyOn(frameSelections, 'frameOpenSelectionPatch')
    .mockImplementation((before, patch, cache, keys, ...rest) => {
      pass = 'writer'
      builtKeys.push([...keys])
      const countedCache = { ...cache }
      for (const key of keys) {
        if (cache[key]) {
          countedCache[key] = countLayout(cache[key])
        }
      }
      return realWriter(before, patch, countedCache, keys, ...rest)
    })
  restores.push(() => writer.mockRestore())
  const realFingerprint = selectionFingerprint.structuredAgentSessionDomainFingerprint
  const fingerprint = vi
    .spyOn(selectionFingerprint, 'structuredAgentSessionDomainFingerprint')
    .mockImplementation((...args) => {
      fingerprints++
      return realFingerprint(...args)
    })
  restores.push(() => fingerprint.mockRestore())
  return {
    reads,
    visits,
    builtKeys,
    fingerprints: () => fingerprints,
    stop: () => restores.toReversed().forEach((restore) => restore())
  }
}
