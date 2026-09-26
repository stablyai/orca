import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'
import {
  buildMobileSessionTabSnapshots,
  registerRuntimeTerminalTab,
  resetRuntimeMobileSyncProjectionCachesForTests
} from './sync-runtime-graph'
import { getTerminalTabOwnershipIndex, graphState } from './sync-runtime-graph/graph-state'
import { buildMobileSessionAgentStatusByWorktree } from './sync-runtime-graph/mobile-session-inputs'

/**
 * Why operation counts and not wall clock: these memos exist to stop whole-store scans on a path
 * that republishes ~1,200 times during sustained agent output. A threshold in milliseconds would
 * track the test machine; counting the per-tab reads each scan performs does not.
 */

const PUBLICATIONS = 25
const WORKTREES = 300
/** `parsePaneKey` only resolves a pane key whose leaf segment is a real terminal leaf id. */
const STATUS_LEAF_ID = 'dddddddd-1111-4111-8111-111111111111'

function makeTab(id: string, worktreeId: string, title = 'Agent'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeStatusEntry(paneKey: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: []
  }
}

/** `tab.id` is read only while a scan walks the tabs, so its read count is the rebuild counter. */
function makeCountingTabs(worktreeCount: number): {
  tabsByWorktree: AppState['tabsByWorktree']
  idReads: () => number
  resetIdReads: () => void
} {
  let idReads = 0
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  for (let index = 0; index < worktreeCount; index += 1) {
    const worktreeId = `repo::/memo-wt-${index}`
    tabsByWorktree[worktreeId] = [
      {
        ...makeTab(`memo-term-${index}`, worktreeId, `Agent ${index}`),
        get id() {
          idReads += 1
          return `memo-term-${index}`
        }
      }
    ]
  }
  return {
    tabsByWorktree,
    idReads: () => idReads,
    resetIdReads: () => {
      idReads = 0
    }
  }
}

beforeEach(() => {
  resetRuntimeMobileSyncProjectionCachesForTests()
})

describe('ambiguous terminal tab id memoization', () => {
  it('scans the tabs once across many publications with an unchanged slice', () => {
    const { tabsByWorktree, idReads, resetIdReads } = makeCountingTabs(WORKTREES)

    getTerminalTabOwnershipIndex(tabsByWorktree)
    expect(idReads()).toBeGreaterThan(0)
    resetIdReads()

    for (let publication = 0; publication < PUBLICATIONS; publication += 1) {
      getTerminalTabOwnershipIndex(tabsByWorktree)
    }

    expect(idReads()).toBe(0)
  })

  it('rescans when the tabs slice is replaced', () => {
    const { tabsByWorktree, idReads, resetIdReads } = makeCountingTabs(WORKTREES)

    getTerminalTabOwnershipIndex(tabsByWorktree)
    const firstScanReads = idReads()
    resetIdReads()

    // A copy-on-write replacement is what every tab writer produces; the memo must not survive it.
    getTerminalTabOwnershipIndex({ ...tabsByWorktree })

    expect(idReads()).toBe(firstScanReads)
  })

  it('reports a duplicate id introduced by a replacement slice', () => {
    const { tabsByWorktree } = makeCountingTabs(2)

    expect([...getTerminalTabOwnershipIndex(tabsByWorktree).ambiguousTabIds]).toEqual([])
    const duplicated: AppState['tabsByWorktree'] = {
      ...tabsByWorktree,
      'repo::/memo-wt-1': [makeTab('memo-term-0', 'repo::/memo-wt-1', 'Clone')]
    }

    expect([...getTerminalTabOwnershipIndex(duplicated).ambiguousTabIds]).toEqual(['memo-term-0'])
  })
})

describe('mobile session agent status grouping memoization', () => {
  const statusPaneKey = `memo-term-7:${STATUS_LEAF_ID}`
  const agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {
    [statusPaneKey]: makeStatusEntry(statusPaneKey)
  }

  it('builds the tab index once across many publications with unchanged slices', () => {
    const { tabsByWorktree, idReads, resetIdReads } = makeCountingTabs(WORKTREES)

    buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    expect(idReads()).toBeGreaterThan(0)
    resetIdReads()

    for (let publication = 0; publication < PUBLICATIONS; publication += 1) {
      buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    }

    expect(idReads()).toBe(0)
  })

  // The memo used to key the tab index on the status slice too, so one OSC frame re-walked every
  // tab in the store. Ownership depends on `tabsByWorktree` alone; only the grouping is redone.
  it('regroups without re-walking the tab index when only the status slice changes', () => {
    const { tabsByWorktree, idReads, resetIdReads } = makeCountingTabs(WORKTREES)

    buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    expect(idReads()).toBeGreaterThan(0)
    resetIdReads()

    const regrouped = buildMobileSessionAgentStatusByWorktree(
      { ...agentStatusByPaneKey },
      tabsByWorktree
    )

    expect(idReads()).toBe(0)
    expect([...regrouped.keys()]).toEqual(['repo::/memo-wt-7'])
  })

  // Bucket identity is the signal the publication loop skips an untouched worktree on; a fresh
  // Map per worktree per frame would make every one of them look dirty.
  it('keeps an untouched worktree bucket identical across a status frame', () => {
    const otherPaneKey = `memo-term-9:${STATUS_LEAF_ID}`
    const { tabsByWorktree } = makeCountingTabs(WORKTREES)
    const twoStatuses: AppState['agentStatusByPaneKey'] = {
      ...agentStatusByPaneKey,
      [otherPaneKey]: makeStatusEntry(otherPaneKey)
    }

    const before = buildMobileSessionAgentStatusByWorktree(twoStatuses, tabsByWorktree)
    const after = buildMobileSessionAgentStatusByWorktree(
      { ...twoStatuses, [otherPaneKey]: { ...makeStatusEntry(otherPaneKey), state: 'waiting' } },
      tabsByWorktree
    )

    expect(after.get('repo::/memo-wt-7')).toBe(before.get('repo::/memo-wt-7'))
    expect(after.get('repo::/memo-wt-9')).not.toBe(before.get('repo::/memo-wt-9'))
  })

  it('rebuilds when the tabs slice changes', () => {
    const { tabsByWorktree, idReads, resetIdReads } = makeCountingTabs(WORKTREES)

    buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, tabsByWorktree)
    const firstBuildReads = idReads()
    resetIdReads()

    buildMobileSessionAgentStatusByWorktree(agentStatusByPaneKey, { ...tabsByWorktree })

    expect(idReads()).toBe(firstBuildReads)
  })

  it('regroups a status entry onto the worktree its tab moved to', () => {
    const movedTab = makeTab('moved-term', 'repo::/from')
    const movedPaneKey = `moved-term:${STATUS_LEAF_ID}`
    const statusByPaneKey: AppState['agentStatusByPaneKey'] = {
      [movedPaneKey]: makeStatusEntry(movedPaneKey)
    }

    const before = buildMobileSessionAgentStatusByWorktree(statusByPaneKey, {
      'repo::/from': [movedTab]
    })
    expect([...before.keys()]).toEqual(['repo::/from'])

    const after = buildMobileSessionAgentStatusByWorktree(statusByPaneKey, {
      'repo::/to': [movedTab]
    })
    expect([...after.keys()]).toEqual(['repo::/to'])
  })
})

/** Distinct ids per file: the per-worktree snapshot memo is module state shared across tests. */
const REGISTERED_WT = 'repo::/memo-registered-wt'
const REGISTERED_LEAF_ID = 'cccccccc-1111-4111-8111-111111111111'

function makeRegistrationState(persistedWorktrees: number): AppState {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    [REGISTERED_WT]: [makeTab('memo-registered-term', REGISTERED_WT, 'Mounted')]
  }
  for (let index = 0; index < persistedWorktrees; index += 1) {
    const worktreeId = `repo::/memo-unmounted-wt-${index}`
    tabsByWorktree[worktreeId] = [
      makeTab(`memo-unmounted-term-${index}`, worktreeId, `Agent ${index}`)
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only the slices assigned here; a full AppState is not constructible in a unit test.
  return {
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {}
  } as unknown as AppState
}

function makeRegistration(tabId: string): Parameters<typeof registerRuntimeTerminalTab>[0] {
  const panes = [{ id: 1, leafId: REGISTERED_LEAF_ID }]
  const manager = {
    getPanes: () => panes.map((pane) => ({ ...pane })),
    getActivePane: () => panes[0] ?? null,
    getLeafId: (paneId: number) => panes.find((pane) => pane.id === paneId)?.leafId ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      panes.find((pane) => pane.leafId === leafId)?.id ?? null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path calls only the PaneManager members stubbed above; a real one needs a live xterm.
  return {
    tabId,
    worktreeId: REGISTERED_WT,
    getManager: () => manager,
    getContainer: () => null,
    getPtyIdForPane: () => 'pty-memo-1',
    getTabWideAgentHintLeafId: () => REGISTERED_LEAF_ID
  } as unknown as Parameters<typeof registerRuntimeTerminalTab>[0]
}

describe('registered terminal tab index', () => {
  it('consults the registration map only for tabs that are actually mounted', () => {
    const state = makeRegistrationState(WORKTREES)
    const unregister = registerRuntimeTerminalTab(makeRegistration('memo-registered-term'))
    const lookups = vi.spyOn(graphState.registeredTabs, 'get')
    try {
      buildMobileSessionTabSnapshots(state)

      // Without the index every persisted tab probes the map; with it, only the mounted one does.
      expect(lookups.mock.calls.length).toBeLessThanOrEqual(2)
    } finally {
      lookups.mockRestore()
      unregister()
    }
  })

  it('stops reporting a tab as registered once its surface unmounts', () => {
    const state = makeRegistrationState(2)
    const unregister = registerRuntimeTerminalTab(makeRegistration('memo-registered-term'))
    const mounted = buildMobileSessionTabSnapshots(state).find(
      (snapshot) => snapshot.worktree === REGISTERED_WT
    )
    expect(mounted?.tabs).toEqual([expect.objectContaining({ ptyId: 'pty-memo-1' })])

    unregister()
    const after = buildMobileSessionTabSnapshots(state).find(
      (snapshot) => snapshot.worktree === REGISTERED_WT
    )

    expect(after?.tabs).not.toEqual([expect.objectContaining({ ptyId: 'pty-memo-1' })])
    expect(graphState.registeredTabIdsByWorktree.get(REGISTERED_WT)).toBeUndefined()
  })

  it('keeps the tab registered when a remount cleans up after its replacement', () => {
    const state = makeRegistrationState(2)
    const first = registerRuntimeTerminalTab(makeRegistration('memo-registered-term'))
    const second = registerRuntimeTerminalTab(makeRegistration('memo-registered-term'))
    try {
      // React can mount the replacement before the old effect tears down; the stale cleanup
      // must not evict the live registration from the index.
      first()

      expect(graphState.registeredTabIdsByWorktree.get(REGISTERED_WT)).toEqual(
        new Set(['memo-registered-term'])
      )
      const mounted = buildMobileSessionTabSnapshots(state).find(
        (snapshot) => snapshot.worktree === REGISTERED_WT
      )
      expect(mounted?.tabs).toEqual([expect.objectContaining({ ptyId: 'pty-memo-1' })])
    } finally {
      second()
    }
  })
})
