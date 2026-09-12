import { afterEach, describe, expect, it } from 'vitest'
import {
  captureParkedTerminalPaneCandidates,
  retireParkedTerminalTab
} from './terminal-parked-watcher-registry'
import {
  reconcileParkedWatcherPtyIds,
  resolveParkedTerminalPaneCandidates
} from './terminal-parked-watcher-reconciliation'

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo::/worktree'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = 'remote:env-1@@terminal-1'
const OLD_SECOND_PTY_ID = 'remote:env-1@@terminal-2'
const NEW_SECOND_PTY_ID = 'remote:env-1@@terminal-3'

afterEach(() => {
  retireParkedTerminalTab(TAB_ID)
})

describe('paired parked-watcher reconciliation', () => {
  it('prefers an authoritative inactive split-leaf remint over the unmount capture', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
      { ptyId: FIRST_PTY_ID, paneId: 1, leafId: FIRST_LEAF_ID, drivesTabTitle: true },
      {
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 2,
        leafId: SECOND_LEAF_ID,
        drivesTabTitle: false
      }
    ])

    const panes = resolveParkedTerminalPaneCandidates(
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

// Why: the sole-newborn parity flag is a fact about the captured PTY, so the
// layout-fallback rescue must carry it only while the leaf still binds that PTY.
describe('untouchedFreshSpawn carry through the layout-fallback rescue', () => {
  const soleLeafState = {
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf' as const, leafId: FIRST_LEAF_ID },
        activeLeafId: FIRST_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [FIRST_LEAF_ID]: FIRST_PTY_ID }
      }
    }
  }

  it('keeps the captured fact for the same PTY when the rescue runs', () => {
    // Stale capture (an extra pane the layout no longer has) forces the rescue path.
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
      {
        ptyId: FIRST_PTY_ID,
        paneId: 1,
        leafId: FIRST_LEAF_ID,
        drivesTabTitle: true,
        untouchedFreshSpawn: true
      },
      { ptyId: OLD_SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])

    const panes = resolveParkedTerminalPaneCandidates(
      { id: TAB_ID, ptyId: FIRST_PTY_ID },
      soleLeafState
    )

    expect(panes).toHaveLength(1)
    expect(panes[0].untouchedFreshSpawn).toBe(true)
  })

  it('drops the fact when the leaf re-minted a different PTY', () => {
    captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, [
      {
        ptyId: OLD_SECOND_PTY_ID,
        paneId: 1,
        leafId: FIRST_LEAF_ID,
        drivesTabTitle: true,
        untouchedFreshSpawn: true
      }
    ])

    const panes = resolveParkedTerminalPaneCandidates(
      { id: TAB_ID, ptyId: FIRST_PTY_ID },
      soleLeafState
    )

    expect(panes).toHaveLength(1)
    expect(panes[0].untouchedFreshSpawn).toBeUndefined()
  })
})
