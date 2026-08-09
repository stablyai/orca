import { afterEach, describe, expect, it } from 'vitest'
import {
  captureParkedTerminalPaneCandidates,
  retireParkedTerminalTab
} from './terminal-parked-watcher-registry'
import {
  createParkedTerminalWatcherTopologyKey,
  normalizeParkedTerminalPaneMaterialBindings,
  reconcileParkedWatcherPtyIds,
  resolveParkedTerminalPaneCandidates
} from './terminal-parked-watcher-reconciliation'

const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const WORKTREE_ID = 'repo::/worktree'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = 'remote:env-1@@terminal-1'
const OLD_SECOND_PTY_ID = 'remote:env-1@@terminal-2'
const NEW_SECOND_PTY_ID = 'remote:env-1@@terminal-3'

type TopologyState = Parameters<typeof resolveParkedTerminalPaneCandidates>[2]

function singlePaneTopologyState(args?: {
  firstTitleSlot?: number
  firstTitle?: string
}): TopologyState {
  return {
    runtimePaneTitlesByTabId: {
      [TAB_ID]: { [args?.firstTitleSlot ?? 1]: args?.firstTitle ?? 'first title' },
      [OTHER_TAB_ID]: { 2: 'second title' }
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: FIRST_LEAF_ID },
        activeLeafId: FIRST_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [FIRST_LEAF_ID]: FIRST_PTY_ID }
      },
      [OTHER_TAB_ID]: {
        root: { type: 'leaf', leafId: SECOND_LEAF_ID },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SECOND_LEAF_ID]: OLD_SECOND_PTY_ID }
      }
    }
  }
}

function splitPaneTopologyState(secondPtyId: string): TopologyState {
  return {
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: FIRST_LEAF_ID },
          second: { type: 'leaf', leafId: SECOND_LEAF_ID }
        },
        activeLeafId: FIRST_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [FIRST_LEAF_ID]: FIRST_PTY_ID,
          [SECOND_LEAF_ID]: secondPtyId
        }
      }
    }
  }
}

afterEach(() => {
  retireParkedTerminalTab(TAB_ID)
  retireParkedTerminalTab(OTHER_TAB_ID)
})

describe('paired parked-watcher reconciliation', () => {
  it('normalizes only mount-independent leaf and PTY bindings', () => {
    const captures = [
      {
        leafId: SECOND_LEAF_ID,
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 7,
        drivesTabTitle: true
      },
      { leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID, paneId: 4, drivesTabTitle: false }
    ]
    expect(normalizeParkedTerminalPaneMaterialBindings(captures)).toEqual([
      { leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID },
      { leafId: SECOND_LEAF_ID, ptyId: OLD_SECOND_PTY_ID }
    ])
  })

  it('keeps the topology key stable across tab order', () => {
    const tabs = [
      { id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 1 },
      { id: OTHER_TAB_ID, ptyId: OLD_SECOND_PTY_ID, generation: 2 }
    ]
    const state = singlePaneTopologyState()

    expect(createParkedTerminalWatcherTopologyKey(WORKTREE_ID, tabs, state)).toBe(
      createParkedTerminalWatcherTopologyKey(WORKTREE_ID, tabs.toReversed(), state)
    )
  })

  it('ignores pane metadata, runtime titles, and capture source', () => {
    const tabs = [{ id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 1 }]
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 1, [
      {
        leafId: FIRST_LEAF_ID,
        ptyId: FIRST_PTY_ID,
        paneId: 99,
        drivesTabTitle: false
      }
    ])
    const capturedKey = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      tabs,
      singlePaneTopologyState({ firstTitleSlot: 3, firstTitle: 'old title' })
    )

    retireParkedTerminalTab(TAB_ID)
    const fallbackKey = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      tabs,
      singlePaneTopologyState({ firstTitleSlot: 17, firstTitle: 'new title' })
    )

    expect(fallbackKey).toBe(capturedKey)
  })

  it('changes the topology key when a tab generation changes', () => {
    const state = singlePaneTopologyState()
    const original = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      [{ id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 1 }],
      state
    )
    const reminted = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      [{ id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 2 }],
      state
    )

    expect(reminted).not.toBe(original)
  })

  it('changes the topology key for a layout-only leaf-to-PTY remint', () => {
    const tabs = [{ id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 1 }]
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 1, [
      { leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID, paneId: 1, drivesTabTitle: true },
      {
        leafId: SECOND_LEAF_ID,
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 2,
        drivesTabTitle: false
      }
    ])
    const original = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      tabs,
      splitPaneTopologyState(OLD_SECOND_PTY_ID)
    )
    const reminted = createParkedTerminalWatcherTopologyKey(
      WORKTREE_ID,
      tabs,
      splitPaneTopologyState(NEW_SECOND_PTY_ID)
    )

    expect(reminted).not.toBe(original)
  })

  it('prefers an authoritative inactive split-leaf remint over the unmount capture', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, null, [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true },
      {
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 2,
        leafId: SECOND_LEAF_ID,
        drivesTabTitle: false
      }
    ])

    const panes = resolveParkedTerminalPaneCandidates(
      WORKTREE_ID,
      { id: TAB_ID, ptyId: FIRST_PTY_ID },
      {
        runtimePaneTitlesByTabId: {},
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: FIRST_LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: FIRST_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [FIRST_LEAF_ID]: FIRST_PTY_ID,
              [SECOND_LEAF_ID]: NEW_SECOND_PTY_ID
            }
          }
        }
      }
    )

    expect(panes).toEqual([
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true },
      {
        ptyId: NEW_SECOND_PTY_ID,
        paneId: 2,
        leafId: SECOND_LEAF_ID,
        drivesTabTitle: false
      }
    ])
  })

  it('takes split title authority from the current layout instead of the capture', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, null, [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true },
      {
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 2,
        leafId: SECOND_LEAF_ID,
        drivesTabTitle: false
      }
    ])

    const panes = resolveParkedTerminalPaneCandidates(
      WORKTREE_ID,
      { id: TAB_ID, ptyId: FIRST_PTY_ID },
      {
        runtimePaneTitlesByTabId: {},
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            ...splitPaneTopologyState(OLD_SECOND_PTY_ID).terminalLayoutsByTabId[TAB_ID],
            activeLeafId: SECOND_LEAF_ID
          }
        }
      }
    )

    expect(panes.map(({ leafId, drivesTabTitle }) => ({ leafId, drivesTabTitle }))).toEqual([
      { leafId: FIRST_LEAF_ID, drivesTabTitle: false },
      { leafId: SECOND_LEAF_ID, drivesTabTitle: true }
    ])
  })

  it('accepts only a capture from the requested worktree and generation', () => {
    const capturedPanes = [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true }
    ]
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 4, capturedPanes)

    expect(
      resolveParkedTerminalPaneCandidates(
        WORKTREE_ID,
        { id: TAB_ID, ptyId: null, generation: 4 },
        { runtimePaneTitlesByTabId: {}, terminalLayoutsByTabId: {} }
      )
    ).toEqual(capturedPanes)
  })

  it('rejects a capture from another worktree when no fallback topology exists', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, 'repo::/old-worktree', 4, [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true }
    ])

    expect(
      resolveParkedTerminalPaneCandidates(
        WORKTREE_ID,
        { id: TAB_ID, ptyId: null, generation: 4 },
        { runtimePaneTitlesByTabId: {}, terminalLayoutsByTabId: {} }
      )
    ).toEqual([])
  })

  it('rejects a same-PTY capture from a previous tab generation', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 3, [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true }
    ])

    expect(
      resolveParkedTerminalPaneCandidates(
        WORKTREE_ID,
        { id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 4 },
        { runtimePaneTitlesByTabId: {}, terminalLayoutsByTabId: {} }
      )
    ).toEqual([])
  })

  it('does not reuse pane metadata from a stale capture', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, 3, [
      { ptyId: FIRST_PTY_ID, paneId: 99, leafId: FIRST_LEAF_ID, drivesTabTitle: false }
    ])

    expect(
      resolveParkedTerminalPaneCandidates(
        WORKTREE_ID,
        { id: TAB_ID, ptyId: FIRST_PTY_ID, generation: 4 },
        singlePaneTopologyState()
      )
    ).toEqual([{ ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true }])
  })

  it('surgically reconciles a reminted split leaf without restarting its sibling', () => {
    expect(
      reconcileParkedWatcherPtyIds({
        currentTabPtyId: FIRST_PTY_ID,
        entryTabPtyId: FIRST_PTY_ID,
        paneIdByPtyId: new Map([
          [FIRST_PTY_ID, 1],
          [OLD_SECOND_PTY_ID, 2]
        ]),
        expectedPtyIds: new Set([FIRST_PTY_ID, NEW_SECOND_PTY_ID])
      })
    ).toEqual({
      restartAll: false,
      addedPtyIds: [NEW_SECOND_PTY_ID],
      retainedPtyIds: [FIRST_PTY_ID],
      retiredPaneIds: [2]
    })
  })
})
