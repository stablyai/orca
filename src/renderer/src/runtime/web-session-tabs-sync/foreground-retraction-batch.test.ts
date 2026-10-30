import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import * as records from './state-equality-core'
import * as leaves from '../../../../shared/terminal-pane-layout-tree'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsSnapshotOperations
} from './snapshot-api'
import {
  makeState,
  makeSnapshot,
  LEAF_ID,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  NOW,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import {
  buildCurrentForegroundLeafRetractionPatch,
  recordPaneKeysForTabs
} from './retraction-pane-ownership'
import type { WebSessionTabsBatchContext } from './state'

vi.mock('@/store', () => ({ useAppStore: { setState: vi.fn() } }))
beforeEach(resetWebSessionTabsSyncTestState)
afterEach(() => vi.restoreAllMocks())
const FOREIGN = makePaneKey('unrelated', THIRD_LEAF_ID)
const tabId = (i: number) => toWebTerminalSurfaceTabId(`host-${i}`)
const key = (i: number, leaf = LEAF_ID) => makePaneKey(tabId(i), leaf)
function entry(worktreeId: string, host = 'host-a', ptyId = 'pty'): PaneForegroundAgentEntry {
  return {
    agent: 'pi',
    agentEvidence: 'process-admitted',
    shellForeground: false,
    context: {
      execution: {},
      ptyId,
      incarnationId: 'inc',
      worktreeId,
      environmentId: host
    }
  }
}
function frame(i: number, leafIds = [SECOND_LEAF_ID]) {
  return makeSnapshot(
    leafIds.map((leafId) => ({
      type: 'terminal' as const,
      id: `host-${i}::${leafId}`,
      parentTabId: `host-${i}`,
      leafId,
      title: 'shell',
      isActive: true,
      status: 'ready' as const,
      terminal: `pty-${leafId}`
    })),
    { worktree: `folder:${i}` }
  )
}

it('bounds actual nonempty snapshot/operations batches through index, leaf walk, copy and final publication', () => {
  for (const operations of [false, true]) {
    for (const size of [10, 100]) {
      resetWebSessionTabsSyncTestState()
      let state = makeState()
      const initial = Array.from({ length: size }, (_, i) => frame(i, [LEAF_ID, SECOND_LEAF_ID]))
      state = { ...state, ...applyWebSessionTabsSnapshots(state, initial, 'host-a', NOW) }
      const foreground = { [FOREIGN]: entry('foreign', 'host-b') }
      for (let i = 0; i < size; i++) {
        foreground[key(i)] = entry(
          `folder:${i}`,
          'host-a',
          state.terminalLayoutsByTabId[tabId(i)].ptyIdsByLeafId?.[LEAF_ID]
        )
        foreground[key(i, SECOND_LEAF_ID)] = entry(
          `folder:${i}`,
          'host-a',
          state.terminalLayoutsByTabId[tabId(i)].ptyIdsByLeafId?.[SECOND_LEAF_ID]
        )
        foreground[key(i, THIRD_LEAF_ID)] = entry(`folder:${i}`, 'host-b')
      }
      state.paneForegroundAgentByPaneKey = foreground
      const originalKeys = Object.keys
      let enumerations = 0,
        indexedKeys = 0,
        copies = 0,
        leafVisits = 0,
        indexUpdates = 0,
        flushes = 0,
        flushedRecords = 0
      const contexts = new WeakSet<object>()
      let currentForeground: typeof state.paneForegroundAgentByPaneKey
      const originalDelete = Set.prototype.delete
      vi.spyOn(Set.prototype, 'delete').mockImplementation(function (
        this: Set<unknown>,
        value: unknown
      ) {
        if (
          typeof value === 'string' &&
          value.startsWith('web-terminal-host-') &&
          value.includes(':')
        ) {
          indexUpdates++
        }
        return originalDelete.call(this, value)
      })
      vi.spyOn(Object, 'keys').mockImplementation((record) => {
        const result = originalKeys(record)
        if (Object.hasOwn(record, FOREIGN)) {
          enumerations++
          indexedKeys += result.length
        }
        return result
      })
      const originalWrite = records.writableWebSessionTabsRecord
      vi.spyOn(records, 'writableWebSessionTabsRecord').mockImplementation((s, name, context) => {
        if (context && !contexts.has(context)) {
          contexts.add(context)
          const iterate = context.changedRecords[Symbol.iterator].bind(context.changedRecords)
          vi.spyOn(context.changedRecords, Symbol.iterator).mockImplementation(function* () {
            flushes++
            for (const record of iterate()) {
              flushedRecords++
              yield record
            }
          })
        }
        const before = s[name]
        const result = originalWrite(s, name, context)
        if (name === 'paneForegroundAgentByPaneKey') {
          if (result !== before) {
            copies++
          }
          currentForeground = s.paneForegroundAgentByPaneKey
        }
        return result
      })
      const originalLeaves = leaves.collectLeafIds
      vi.spyOn(leaves, 'collectLeafIds').mockImplementation((root) => {
        const result = originalLeaves(root)
        leafVisits += result.length
        return result
      })
      const apply = (snapshots: ReturnType<typeof frame>[]) =>
        operations
          ? applyWebSessionTabsSnapshotOperations(
              state,
              snapshots.map((snapshot) => ({
                environmentId: 'host-a',
                snapshot,
                decision: { apply: true, settlesHostMirror: true }
              }))
            )
          : applyWebSessionTabsSnapshots(state, snapshots, 'host-a', NOW)
      // A real nonempty unchanged batch indexes the stable record once and never copies it.
      state = { ...state, ...apply(Array.from({ length: size }, (_, i) => initial[i])) }
      expect(state.paneForegroundAgentByPaneKey).toBe(foreground)
      expect(enumerations).toBe(1)
      expect(indexedKeys).toBe(3 * size + 1)
      expect(copies).toBe(0)
      enumerations = indexedKeys = leafVisits = indexUpdates = flushes = flushedRecords = 0
      // Several frames mutate the same owned output, then revisit the removed key.
      const removals = Array.from({ length: size }, (_, i) => (i % 2 ? frame(i) : frame(i, [])))
      const patch = apply([...removals, ...removals])
      const after = { ...state, ...patch }
      expect(enumerations).toBeLessThanOrEqual(1)
      expect(indexedKeys).toBeLessThanOrEqual(3 * size + 1)
      expect(copies).toBe(1)
      expect(leafVisits).toBeLessThanOrEqual(20 * size)
      expect(indexUpdates).toBeGreaterThanOrEqual(size)
      expect(indexUpdates).toBeLessThanOrEqual(4 * size)
      expect(flushes).toBe(1)
      expect(flushedRecords).toBeLessThanOrEqual(24)
      expect(patch.paneForegroundAgentByPaneKey).toBe(currentForeground)
      expect(after.paneForegroundAgentByPaneKey?.[FOREIGN]).toBe(foreground[FOREIGN])
      for (let i = 0; i < size; i++) {
        expect(after.paneForegroundAgentByPaneKey?.[key(i)]).toBeUndefined()
        expect(after.paneForegroundAgentByPaneKey?.[key(i, SECOND_LEAF_ID)]).toBe(
          i % 2 ? foreground[key(i, SECOND_LEAF_ID)] : undefined
        )
        expect(after.paneForegroundAgentByPaneKey?.[key(i, THIRD_LEAF_ID)]).toBe(
          foreground[key(i, THIRD_LEAF_ID)]
        )
      }
      expect(foreground[key(0)]).toBeDefined()
      console.log({
        operations,
        size,
        enumerations,
        indexedKeys,
        copies,
        leafVisits,
        indexUpdates,
        flushes,
        flushedRecords
      })
      vi.restoreAllMocks()
    }
  }
})

it('keeps replacement and in-place removal indexes current, including unhydrated and standalone frames', () => {
  let state = makeState()
  const initial = frame(0, [LEAF_ID, SECOND_LEAF_ID])
  state = { ...state, ...applyWebSessionTabsSnapshot(state, initial, 'host-a', NOW) }
  state.paneForegroundAgentByPaneKey = {
    [key(0)]: entry('folder:0'),
    [FOREIGN]: entry('foreign', 'host-b')
  }
  const context: WebSessionTabsBatchContext = {
    changedRecords: new Set(),
    agentPaneKeysByTabId: null,
    openFilesIndex: null
  }
  expect(
    recordPaneKeysForTabs(state.paneForegroundAgentByPaneKey, new Set([tabId(0)]), context)
  ).toEqual([key(0)])
  const patch = applyWebSessionTabsSnapshot(state, frame(0), 'host-a', NOW)
  expect(patch.paneForegroundAgentByPaneKey?.[key(0)]).toBeUndefined()
  // A replacement invalidates the identity-keyed index; same-copy removals update its membership.
  state.paneForegroundAgentByPaneKey = {
    [key(0)]: entry('folder:0'),
    [key(0, SECOND_LEAF_ID)]: entry('folder:0')
  }
  const layouts = {
    [tabId(0)]: {
      root: { type: 'leaf' as const, leafId: SECOND_LEAF_ID },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null
    }
  }
  buildCurrentForegroundLeafRetractionPatch(
    state,
    state.paneForegroundAgentByPaneKey,
    layouts,
    new Set([tabId(0)]),
    'host-a',
    'folder:0',
    context
  )
  expect(
    recordPaneKeysForTabs(state.paneForegroundAgentByPaneKey, new Set([tabId(0)]), context)
  ).toEqual([key(0, SECOND_LEAF_ID)])
  state.tabsByWorktree = {}
  state.terminalLayoutsByTabId = {}
  const removed = applyWebSessionTabsSnapshots(state, [frame(0, []), frame(0, [])], 'host-a', NOW)
  expect(removed.paneForegroundAgentByPaneKey).toEqual({})
})
