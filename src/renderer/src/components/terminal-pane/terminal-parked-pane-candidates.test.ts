import { describe, expect, it } from 'vitest'
import { fallbackParkedPaneCandidates } from './terminal-parked-tab-watchers'

const TAB_ID = 'tab-1'
const PTY_ID = 'repo::/worktree@@session-1'
const SECOND_PTY_ID = 'repo::/worktree@@session-2'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

describe('fallbackParkedPaneCandidates', () => {
  it('returns nothing without a layout snapshot', () => {
    expect(
      fallbackParkedPaneCandidates(
        { id: TAB_ID, ptyId: PTY_ID },
        { terminalLayoutsByTabId: {}, runtimePaneTitlesByTabId: {} }
      )
    ).toEqual([])
  })

  it('reuses the single runtime-title slot for a single-pane tab', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: null }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 7: 'working title' } }
      } as never)
    ).toEqual([{ ptyId: PTY_ID, paneId: 7, leafId: LEAF_ID, drivesTabTitle: true }])
  })

  // Why: a tab that never mounted a pane persists a rootless layout. Walking
  // only `root` yielded zero candidates, so watcher coverage refused it and a
  // manual park could never succeed for a workspace the user had not visited.
  it('resolves the single leaf of a rootless layout', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: null,
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
          }
        },
        runtimePaneTitlesByTabId: {}
      } as never)
    ).toEqual([{ ptyId: PTY_ID, paneId: -1, leafId: LEAF_ID, drivesTabTitle: true }])
  })

  it('returns nothing for a rootless layout with no resolvable leaf', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: { root: null, activeLeafId: null, expandedLeafId: null }
        },
        runtimePaneTitlesByTabId: {}
      } as never)
    ).toEqual([])
  })

  it('maps split leaves to layout PTYs with collision-free negative pane ids', () => {
    expect(
      fallbackParkedPaneCandidates({ id: TAB_ID, ptyId: PTY_ID }, {
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'row',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: SECOND_PTY_ID }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'a', 2: 'b' } }
      } as never)
    ).toEqual([
      { ptyId: PTY_ID, paneId: -1, leafId: LEAF_ID, drivesTabTitle: false },
      { ptyId: SECOND_PTY_ID, paneId: -2, leafId: SECOND_LEAF_ID, drivesTabTitle: true }
    ])
  })
})
