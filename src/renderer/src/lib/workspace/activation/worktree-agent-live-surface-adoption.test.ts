import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adoptLiveWorkspacePtySurfaces,
  type LiveSurfaceAdoptionStore
} from './worktree-agent-live-surface-adoption'
import type { LiveTerminalSurfaceOwnerIndex } from '../ownership/worktree-live-terminal-surface-owners'

const WORKTREE_ID = 'repo-1::/workspace/repo'
const RECORDED_TAB_ID = 'recorded-tab'
const ORPHAN_PTY_ID = '3'
const NOW = 1_700_000_000_000

describe('orphan local counter PTY adoption on workspace activation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints no fresh tab when its recorded pane cannot be restored', async () => {
    const state = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      closedTerminalTabTombstonesByTabId: {
        [RECORDED_TAB_ID]: { closedAt: NOW, worktreeId: WORKTREE_ID }
      },
      createTab: vi.fn()
    }
    const census = new Map([
      [
        ORPHAN_PTY_ID,
        {
          unowned: true as const,
          recorded: {
            paneKey: `${RECORDED_TAB_ID}:4f0c2d1e-8a7b-4c3d-9e2f-1a2b3c4d5e6f`,
            ptyId: ORPHAN_PTY_ID,
            tabId: RECORDED_TAB_ID
          }
        }
      ]
    ]) satisfies LiveTerminalSurfaceOwnerIndex

    const adoption = await adoptLiveWorkspacePtySurfaces(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads only these fields for a worktree with no tabs.
      () => state as unknown as LiveSurfaceAdoptionStore,
      WORKTREE_ID,
      [ORPHAN_PTY_ID],
      () => Promise.resolve(census)
    )

    expect(state.createTab).not.toHaveBeenCalled()
    expect(adoption).toEqual({ surfaced: false, declinedPtyIds: [ORPHAN_PTY_ID] })
  })
})
