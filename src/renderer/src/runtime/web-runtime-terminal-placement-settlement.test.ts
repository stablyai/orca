import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { settleWebRuntimeTerminalPlacement } from './web-runtime-terminal-placement-settlement'
import {
  isWebSessionTerminalPlacementUserMoved,
  markWebSessionTerminalPlacementUserMoved,
  peekWebSessionTerminalPlacementGroup,
  recordWebSessionTerminalPlacement,
  resetWebSessionTerminalPlacementsForTests
} from './web-session-terminal-placement'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  reorderUnifiedTabs: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: { getState: mocks.getState }
}))

const ENV = 'env-1'
const WT = 'repo::/worktree'
const LEFT = 'group-left'
const RIGHT = 'group-right'
const T1 = toWebTerminalSurfaceTabId('host-tab-1')
const T2 = toWebTerminalSurfaceTabId('host-tab-2')
const PLACEMENT = { environmentId: ENV, worktreeId: WT, hostTabId: 'host-tab-2' }

describe('settleWebRuntimeTerminalPlacement', () => {
  beforeEach(() => {
    // The created tab sits in the right split; its create asked for the left pane.
    mocks.getState.mockReturnValue({
      unifiedTabsByWorktree: {
        [WT]: [
          { id: T1, groupId: LEFT },
          { id: T2, groupId: RIGHT }
        ]
      },
      groupsByWorktree: {
        [WT]: [
          { id: LEFT, tabOrder: [T1] },
          { id: RIGHT, tabOrder: [T2] }
        ]
      },
      moveUnifiedTabToGroup: mocks.moveUnifiedTabToGroup,
      reorderUnifiedTabs: mocks.reorderUnifiedTabs
    })
    recordWebSessionTerminalPlacement({ ...PLACEMENT, groupId: LEFT })
  })

  afterEach(() => {
    resetWebSessionTerminalPlacementsForTests()
    vi.clearAllMocks()
  })

  it('moves an untouched tab into the pane its create asked for', async () => {
    await settleWebRuntimeTerminalPlacement(ENV, WT, 'host-tab-2', {
      groupId: LEFT,
      activate: true
    })

    expect(mocks.moveUnifiedTabToGroup).toHaveBeenCalledExactlyOnceWith(T2, LEFT, {
      activate: true,
      recordInteraction: false
    })
    expect(peekWebSessionTerminalPlacementGroup(PLACEMENT)).toBeUndefined()
  })

  // #22792: settlement moved a tab the user had just dragged into a split back to its first pane.
  it('leaves a tab the user moved while the create was settling', async () => {
    markWebSessionTerminalPlacementUserMoved(PLACEMENT)

    await settleWebRuntimeTerminalPlacement(ENV, WT, 'host-tab-2', {
      groupId: LEFT,
      afterTabId: T1,
      activate: true
    })

    expect(mocks.moveUnifiedTabToGroup).not.toHaveBeenCalled()
    expect(mocks.reorderUnifiedTabs).not.toHaveBeenCalled()
    // The record is still consumed, so it cannot outlive the create.
    expect(isWebSessionTerminalPlacementUserMoved(PLACEMENT)).toBe(false)
  })
})
