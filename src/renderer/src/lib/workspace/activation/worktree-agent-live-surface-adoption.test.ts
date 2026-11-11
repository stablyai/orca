import { describe, expect, it, vi } from 'vitest'
import {
  adoptLiveWorkspacePtySurfaces,
  type LiveSurfaceAdoptionStore
} from './worktree-agent-live-surface-adoption'

const WORKTREE_ID = 'repo-1::/workspace/repo'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function adoptionHarness(): {
  getState: () => LiveSurfaceAdoptionStore
  createTab: ReturnType<typeof vi.fn>
} {
  const createTab = vi.fn(() => ({ id: 'created-tab' }))
  const store = {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    closedTerminalTabTombstonesByTabId: {},
    createTab,
    setTabLayout: vi.fn(),
    updateTabPtyId: vi.fn(),
    replaceTerminalLayoutPanePtyId: vi.fn()
  } as unknown as LiveSurfaceAdoptionStore
  return { getState: () => store, createTab }
}

describe('orphan counter PTY adoption (#40920)', () => {
  it('does not mint a tab for an unowned bare counter id', async () => {
    const { getState, createTab } = adoptionHarness()
    const result = await adoptLiveWorkspacePtySurfaces(
      getState,
      WORKTREE_ID,
      ['3'],
      async () => new Map([['3', { unowned: true, recorded: null }]])
    )

    expect(createTab).not.toHaveBeenCalled()
    expect(result.declinedPtyIds).toEqual(['3'])
    expect(result.surfaced).toBe(false)
  })

  it('does not recreate a missing tab for an unowned bare counter with a recorded pane', async () => {
    const { getState, createTab } = adoptionHarness()
    const recorded = {
      paneKey: `old-tab:${LEAF_ID}`,
      ptyId: '13',
      tabId: 'old-tab'
    }
    const result = await adoptLiveWorkspacePtySurfaces(
      getState,
      WORKTREE_ID,
      ['13'],
      async () => new Map([['13', { unowned: true, recorded }]])
    )

    expect(createTab).not.toHaveBeenCalled()
    expect(result.declinedPtyIds).toEqual(['13'])
    expect(result.surfaced).toBe(false)
  })

  it('still mints one tab for an unowned durable session id', async () => {
    const { getState, createTab } = adoptionHarness()
    const ptyId = `${WORKTREE_ID}@@shell-1`
    const result = await adoptLiveWorkspacePtySurfaces(
      getState,
      WORKTREE_ID,
      [ptyId],
      async () => new Map([[ptyId, { unowned: true, recorded: null }]])
    )

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    expect(result.declinedPtyIds).toEqual([])
    expect(result.surfaced).toBe(true)
  })
})
