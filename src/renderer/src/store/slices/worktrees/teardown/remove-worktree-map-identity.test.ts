import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

const REMOVED_ID = 'repo-1::/repos/one/removed'
const SURVIVING_ID = 'repo-1::/repos/one/kept'

/** Only the maps this test asserts on; the cleanup reads them defensively. */
function buildState(): AppState {
  return {
    worktreesByRepo: { 'repo-1': [] },
    tabsByWorktree: { [REMOVED_ID]: [], [SURVIVING_ID]: [] },
    openFiles: [],
    everActivatedWorktreeIds: new Set<string>(),
    lastVisitedAtByWorktreeId: {},
    deleteStateByWorktreeId: {},
    sortEpoch: 0,
    // Worktree-keyed maps that hold nothing for the removed worktree.
    gitStatusByWorktree: { [SURVIVING_ID]: 'clean' },
    gitStatusHugeByWorktree: {},
    showDotfilesByWorktree: { [SURVIVING_ID]: true },
    expandedDirs: {},
    fileSearchStateByWorktree: {},
    layoutByWorktree: { [SURVIVING_ID]: 'grid' },
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    // Tab-keyed maps with no entry for the removed worktree's tabs.
    terminalLayoutsByTabId: { 'other-tab': 'single' },
    ptyIdsByTabId: {},
    expandedPaneByTabId: {},
    sleepingAgentSessionsByPaneKey: {
      'other-tab:leaf': { paneKey: 'other-tab:leaf', worktreeId: SURVIVING_ID }
    },
    agentLaunchConfigByPaneKey: { 'other-tab:leaf': {} }
  } as unknown as AppState
}

function removeWorktree(state: AppState): AppState {
  let current = state
  applyRemoveWorktreeSuccessState(
    (update) => {
      const patch = typeof update === 'function' ? update(current) : update
      current = { ...current, ...patch }
    },
    REMOVED_ID,
    new Set(['removed-tab'])
  )
  return current
}

describe('removeWorktree map identity', () => {
  it('keeps the reference of every map that held nothing for the removed worktree', () => {
    const before = buildState()

    const after = removeWorktree(before)

    // A new reference here rerenders every component selecting the map, for no data change.
    for (const field of [
      'gitStatusByWorktree',
      'gitStatusHugeByWorktree',
      'showDotfilesByWorktree',
      'expandedDirs',
      'fileSearchStateByWorktree',
      'layoutByWorktree',
      'groupsByWorktree',
      'unifiedTabsByWorktree',
      'terminalLayoutsByTabId',
      'ptyIdsByTabId',
      'expandedPaneByTabId',
      'sleepingAgentSessionsByPaneKey',
      'agentLaunchConfigByPaneKey'
    ] as const) {
      expect(after[field], field).toBe(before[field])
    }
  })

  it('still drops the removed worktree from the maps that did hold it', () => {
    const before = buildState()
    Object.assign(before, {
      gitStatusByWorktree: { [REMOVED_ID]: 'dirty', [SURVIVING_ID]: 'clean' },
      terminalLayoutsByTabId: { 'removed-tab': 'single', 'other-tab': 'single' }
    })

    const after = removeWorktree(before)

    expect(after.gitStatusByWorktree).not.toBe(before.gitStatusByWorktree)
    expect(after.gitStatusByWorktree).toEqual({ [SURVIVING_ID]: 'clean' })
    expect(after.terminalLayoutsByTabId).toEqual({ 'other-tab': 'single' })
    expect(after.tabsByWorktree).toEqual({ [SURVIVING_ID]: [] })
  })

  it('drops sleeping records written for the removed worktree after its terminals stopped (#24784)', () => {
    const before = buildState()
    Object.assign(before, {
      sleepingAgentSessionsByPaneKey: {
        'late-tab:leaf': { paneKey: 'late-tab:leaf', worktreeId: REMOVED_ID },
        'other-tab:leaf': { paneKey: 'other-tab:leaf', worktreeId: SURVIVING_ID }
      },
      agentLaunchConfigByPaneKey: { 'late-tab:leaf': {}, 'other-tab:leaf': {} }
    })

    const after = removeWorktree(before)

    expect(Object.keys(after.sleepingAgentSessionsByPaneKey)).toEqual(['other-tab:leaf'])
    expect(Object.keys(after.agentLaunchConfigByPaneKey)).toEqual(['other-tab:leaf'])
  })
})
