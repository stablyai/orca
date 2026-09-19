import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import { buildMobileSessionTabSnapshots, registerRuntimeTerminalTab } from './sync-runtime-graph'
import { getTerminalTabOwnershipIndex, graphState } from './sync-runtime-graph/graph-state'
import { collectMobileSessionWorktreeIds } from './sync-runtime-graph/mobile-session-worktree-sources'
import { createTabKeyedRecordPartitioner } from './sync-runtime-graph/tab-keyed-record-partition'
import { getBrowserTabsByWorktree } from './sync-runtime-graph/sync-projections'
import {
  DIRTY_TAB,
  DIRTY_WT,
  LEAF_ID,
  makeGateState,
  makeTab,
  patchGateState,
  resetPublicationCaches,
  withChangedStatus
} from './sync-runtime-graph-worktree-source-gate.test-support'
import { mutations } from './sync-runtime-graph-worktree-source-mutations.test-support'

/**
 * Why operation counts and not wall clock: the gate exists so a publication costs what the frame
 * changed rather than what the session accumulated. A millisecond threshold would track the test
 * machine; asserting that the work does not grow with the worktree count does not.
 */

const MOUNTED_WT = 'repo::/gate-mounted'

/** `snapshotVersion` counts rebuilds, so it must not be part of a content comparison. */
function contentOf(snapshots: ReturnType<typeof buildMobileSessionTabSnapshots>): unknown {
  return snapshots.map(({ snapshotVersion: _version, ...rest }) => rest)
}

beforeEach(() => {
  resetPublicationCaches()
})

/**
 * One cache write per worktree the publication actually rebuilt: the gated path reuses the cached
 * snapshot and writes nothing, so this counts exactly what the frame failed to skip.
 */
function rebuiltWorktreesPerFrame(mutate: (state: AppState) => AppState): number[] {
  return [20, 400].map((filler) => {
    resetPublicationCaches()
    const { state } = makeGateState(filler)
    buildMobileSessionTabSnapshots(state, false)
    const writes = vi.spyOn(graphState.mobileSessionSnapshotCacheByWorktree, 'set')
    try {
      buildMobileSessionTabSnapshots(mutate(state), false)
      return writes.mock.calls.length
    } finally {
      writes.mockRestore()
    }
  })
}

describe('mobile session publication skips worktrees the frame did not touch', () => {
  it('rebuilds one worktree on a status frame at either scale', () => {
    expect(rebuiltWorktreesPerFrame((state) => withChangedStatus(state, 'waiting'))).toEqual([1, 1])
  })

  // An OSC title frame replaces `tabsByWorktree`, so the ambiguity set must keep its identity when
  // ownership did not move; otherwise every worktree looks dirty on every title tick.
  it('rebuilds one worktree on a tab-title frame at either scale', () => {
    expect(
      rebuiltWorktreesPerFrame((state) => ({
        ...state,
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [DIRTY_WT]: [makeTab(DIRTY_TAB, DIRTY_WT, 'Renamed')]
        }
      }))
    ).toEqual([1, 1])
  })

  it('still republishes the worktree whose status changed', () => {
    const { state } = makeGateState(20)
    const statusOf = (snapshots: ReturnType<typeof buildMobileSessionTabSnapshots>): unknown => {
      const tab = snapshots
        .find((snapshot) => snapshot.worktree === DIRTY_WT)
        ?.tabs.find((candidate) => candidate.type === 'terminal')
      return tab?.type === 'terminal' ? tab.agentStatus?.state : undefined
    }

    expect(statusOf(buildMobileSessionTabSnapshots(state, false))).toBe('working')
    expect(
      statusOf(buildMobileSessionTabSnapshots(withChangedStatus(state, 'waiting'), false))
    ).toBe('waiting')
  })
})

describe('the gate never publishes a stale worktree', () => {
  for (const mutation of mutations) {
    it(`publishes what a cold rebuild would after ${mutation.name} changes`, () => {
      const { state } = makeGateState(12)
      buildMobileSessionTabSnapshots(state, false)
      const mutated = mutation.apply(state)

      const gated = contentOf(buildMobileSessionTabSnapshots(mutated, false))
      graphState.mobileSessionSnapshotCacheByWorktree.clear()
      const cold = contentOf(buildMobileSessionTabSnapshots(mutated, false))

      expect(gated).toEqual(cold)
    })
  }
})

describe('a mounted worktree is never gated on store references alone', () => {
  it('republishes when only the live PaneManager moved', () => {
    const panes = [
      { id: 1, leafId: LEAF_ID },
      { id: 2, leafId: 'ffffffff-1111-4111-8111-111111111111' }
    ]
    let activeIndex = 0
    const manager = {
      getPanes: () => panes.map((pane) => ({ ...pane })),
      getActivePane: () => panes[activeIndex] ?? null,
      getLeafId: (paneId: number) => panes.find((pane) => pane.id === paneId)?.leafId ?? null,
      getNumericIdForLeaf: (leafId: string) =>
        panes.find((pane) => pane.leafId === leafId)?.id ?? null
    }
    const { state } = makeGateState(12)
    const mountedState = patchGateState(state, {
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [MOUNTED_WT]: [makeTab('gate-mounted-term', MOUNTED_WT)]
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path calls only the PaneManager members stubbed above.
    const unregister = registerRuntimeTerminalTab({
      tabId: 'gate-mounted-term',
      worktreeId: MOUNTED_WT,
      getManager: () => manager,
      getContainer: () => null,
      getPtyIdForPane: (paneId: number) => `pty-gate-${paneId}`,
      getTabWideAgentHintLeafId: () => LEAF_ID
    } as unknown as Parameters<typeof registerRuntimeTerminalTab>[0])
    try {
      const activeLeafOf = (): unknown => {
        const tab = buildMobileSessionTabSnapshots(mountedState, false).find(
          (snapshot) => snapshot.worktree === MOUNTED_WT
        )?.tabs[0]
        return tab?.type === 'terminal' ? tab.parentLayout?.activeLeafId : undefined
      }

      const before = activeLeafOf()
      activeIndex = 1
      const after = activeLeafOf()

      expect(before).toBe(LEAF_ID)
      expect(after).toBe('ffffffff-1111-4111-8111-111111111111')
    } finally {
      unregister()
    }
  })
})

describe('publication-wide memos the gate depends on', () => {
  it('reuses the worktree id set until one of its source slices is replaced', () => {
    const { state } = makeGateState(4)
    const first = collectMobileSessionWorktreeIds(state, getBrowserTabsByWorktree(state))

    expect(collectMobileSessionWorktreeIds(state, getBrowserTabsByWorktree(state))).toBe(first)

    const withNewWorktree = patchGateState(state, {
      groupsByWorktree: { ...state.groupsByWorktree, 'repo::/gate-late': [] }
    })
    const second = collectMobileSessionWorktreeIds(
      withNewWorktree,
      getBrowserTabsByWorktree(withNewWorktree)
    )

    expect(second).not.toBe(first)
    expect(second.has('repo::/gate-late')).toBe(true)
  })

  // A pre-browser partial state must not defeat the memo: a fresh `{}` per publication is a cache
  // key that can never match, so the id set would be rebuilt on every frame.
  it('keeps the worktree id set across a publication of a state with no browser slice', () => {
    const { state } = makeGateState(4)
    const browserless = patchGateState(state, { browserTabsByWorktree: undefined })
    const seeded = collectMobileSessionWorktreeIds(
      browserless,
      getBrowserTabsByWorktree(browserless)
    )

    buildMobileSessionTabSnapshots(browserless, false)

    expect(
      collectMobileSessionWorktreeIds(browserless, getBrowserTabsByWorktree(browserless))
    ).toBe(seeded)
  })

  it('keeps an untouched worktree bucket identical when a tab-keyed record is replaced', () => {
    const { state } = makeGateState(4)
    const owners = getTerminalTabOwnershipIndex(state.tabsByWorktree)
    const partition = createTabKeyedRecordPartitioner<Record<number, string>>()
    // The store replaces the record but keeps every untouched entry object, which is what the
    // bucket comparison relies on.
    const untouched = { 1: 'vim' }
    const before = partition({ [DIRTY_TAB]: untouched }, owners)
    const after = partition({ [DIRTY_TAB]: untouched, 'gate-filler-term-0': { 1: 'less' } }, owners)

    expect(after.get(DIRTY_WT)).toBe(before.get(DIRTY_WT))
    expect(after.get('repo::/gate-filler-0')?.get('gate-filler-term-0')).toEqual({ 1: 'less' })
  })

  it('drops a bucket whose tab id became ambiguous', () => {
    const owners = getTerminalTabOwnershipIndex({
      [DIRTY_WT]: [makeTab('shared-term', DIRTY_WT)],
      'repo::/gate-other': [makeTab('shared-term', 'repo::/gate-other')]
    })
    const partition = createTabKeyedRecordPartitioner<Record<number, string>>()

    expect([...partition({ 'shared-term': { 1: 'vim' } }, owners).keys()]).toEqual([])
  })
})
