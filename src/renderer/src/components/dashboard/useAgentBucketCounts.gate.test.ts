import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import {
  resetAgentBucketCountStateForTests,
  selectAgentBucketCountState
} from './useAgentBucketCounts'

vi.mock('@/store', () => ({ useAppStore: () => undefined }))

const STORE_WRITES = 2_000

function storeState(): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    folderWorkspaces: [],
    acknowledgedAgentsByPaneKey: {},
    agentStatusEpoch: 0,
    // A slice the counts never read: writing it is what "unrelated store write" means.
    unreadCountsByWorktree: {}
  } as unknown as AppState
}

// What `useShallow` did before the gate, unwrapped from the hook so it can be
// driven directly: allocate the 14-key object, then `shallow()` it against the
// previous one. Kept here as the comparison baseline.
let previousShallow: Record<string, unknown> | null = null
const shallowInputs = (s: AppState): Record<string, unknown> => ({
  repos: s.repos,
  worktreesByRepo: s.worktreesByRepo,
  tabsByWorktree: s.tabsByWorktree,
  unifiedTabsByWorktree: s.unifiedTabsByWorktree,
  agentStatusByPaneKey: s.agentStatusByPaneKey,
  retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
  migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
  runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
  terminalLayoutsByTabId: s.terminalLayoutsByTabId,
  ptyIdsByTabId: s.ptyIdsByTabId,
  runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
  folderWorkspaces: s.folderWorkspaces,
  acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
  agentStatusEpoch: s.agentStatusEpoch
})
const shallowSelector = (s: AppState): Record<string, unknown> => {
  const next = shallowInputs(s)
  if (previousShallow !== null && shallow(previousShallow, next)) {
    return previousShallow
  }
  previousShallow = next
  return next
}

function countAllocations(run: () => void): { entries: number; maps: number } {
  const realEntries = Object.entries
  const RealMap = globalThis.Map
  let entries = 0
  let maps = 0
  Object.entries = ((target: object) => {
    entries += 1
    return realEntries(target)
  }) as typeof Object.entries
  class CountingMap<K, V> extends RealMap<K, V> {
    constructor(init?: readonly (readonly [K, V])[] | null) {
      super(init as never)
      maps += 1
    }
  }
  globalThis.Map = CountingMap as unknown as MapConstructor
  try {
    run()
  } finally {
    Object.entries = realEntries
    globalThis.Map = RealMap
  }
  return { entries, maps }
}

afterEach(() => {
  resetAgentBucketCountStateForTests()
  previousShallow = null
})

describe('agent bucket count input gate', () => {
  it('allocates nothing on a store write that leaves all fourteen slices alone', () => {
    const state = storeState()
    // Prime the gate, then replay the writes an unrelated slice would trigger.
    selectAgentBucketCountState(state)

    const gated = countAllocations(() => {
      for (let write = 0; write < STORE_WRITES; write += 1) {
        selectAgentBucketCountState(state)
      }
    })
    const shallowBaseline = countAllocations(() => {
      shallowSelector(state)
      for (let write = 0; write < STORE_WRITES; write += 1) {
        shallowSelector(state)
      }
    })

    expect(gated).toEqual({ entries: 0, maps: 0 })
    // zustand v5's shallow() takes the compareEntries path on a plain object:
    // two Object.entries arrays and two Maps per write, to conclude nothing moved.
    expect(shallowBaseline.entries).toBe(STORE_WRITES * 2)
    expect(shallowBaseline.maps).toBe(STORE_WRITES * 2)
  })

  it('returns the identical inputs object until a read slice changes identity', () => {
    const state = storeState()
    const first = selectAgentBucketCountState(state)
    expect(selectAgentBucketCountState(state)).toBe(first)

    const unrelated = {
      ...state,
      unreadCountsByWorktree: {}
    } as unknown as AppState
    expect(selectAgentBucketCountState(unrelated)).toBe(first)

    const moved = { ...state, agentStatusEpoch: 1 } as unknown as AppState
    const second = selectAgentBucketCountState(moved)
    expect(second).not.toBe(first)
    expect(second.agentStatusEpoch).toBe(1)
  })

  it('carries every slice the counts read, and settings pinned to null', () => {
    const state = storeState()
    const inputs = selectAgentBucketCountState(state)
    expect(inputs.settings).toBeNull()
    for (const key of [
      'repos',
      'worktreesByRepo',
      'tabsByWorktree',
      'unifiedTabsByWorktree',
      'agentStatusByPaneKey',
      'retainedAgentsByPaneKey',
      'migrationUnsupportedByPtyId',
      'runtimeAgentOrchestrationByPaneKey',
      'terminalLayoutsByTabId',
      'ptyIdsByTabId',
      'runtimePaneTitlesByTabId',
      'folderWorkspaces',
      'acknowledgedAgentsByPaneKey',
      'agentStatusEpoch'
    ] as const) {
      expect(inputs[key], key).toBe(state[key])
    }
  })
})
