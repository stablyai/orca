// Ownership is tab-keyed, so this sweep's "is the PTY already shown?" question no longer has a
// worktree in it. A pane filed under another key counts; an orphan layout with no row does not.
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  adoptLiveWorkspacePtySurfaces,
  type LiveSurfaceAdoptionStore
} from './worktree-agent-live-surface-adoption'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LIVE_PTY_ID = 'repo::/worktree@@live-agent'

function boundLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: LIVE_PTY_ID }
  }
}

function row(worktreeId: string, id = 'tab-live'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function store(tabsByWorktree: Record<string, TerminalTab[]>): LiveSurfaceAdoptionStore {
  return {
    createTab: vi.fn(() => row(WORKTREE_ID, 'tab-minted')),
    ptyIdsByTabId: {},
    setTabLayout: vi.fn(),
    tabsByWorktree,
    terminalLayoutsByTabId: { 'tab-live': boundLayout() },
    updateTabPtyId: vi.fn(),
    replaceTerminalLayoutPanePtyId: vi.fn()
  }
}

describe('live pty surface adoption across worktree keys', () => {
  it('treats a pane filed under another worktree key as already surfaced', async () => {
    // Surfacing one PTY twice is the STA-7961 failure; a foreign key is not a second chance.
    const state = store({ [OTHER_WORKTREE_ID]: [row(OTHER_WORKTREE_ID)] })
    const listSurfaceOwners = vi.fn(async () => new Map())

    const result = await adoptLiveWorkspacePtySurfaces(
      () => state,
      WORKTREE_ID,
      [LIVE_PTY_ID],
      listSurfaceOwners
    )

    expect(result).toEqual({ surfaced: true, declinedPtyIds: [] })
    expect(listSurfaceOwners).not.toHaveBeenCalled()
    expect(state.createTab).not.toHaveBeenCalled()
  })

  it('does not count a layout whose row is gone, since it surfaces nothing', async () => {
    const state = store({})
    const listSurfaceOwners = vi.fn(async () => new Map())

    await adoptLiveWorkspacePtySurfaces(() => state, WORKTREE_ID, [LIVE_PTY_ID], listSurfaceOwners)

    expect(listSurfaceOwners).toHaveBeenCalledWith(WORKTREE_ID)
  })
})
