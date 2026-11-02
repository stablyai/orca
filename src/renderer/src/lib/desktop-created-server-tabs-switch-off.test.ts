import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  forgetDesktopCreatedServerTabsOf,
  noteDesktopCreatedServerTab,
  pruneDesktopCreatedServerTabs
} from './desktop-created-server-tabs'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

describe('the desktop-created server tab record in a switch-off build', () => {
  it('never reads nor keeps the record', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage)
    noteDesktopCreatedServerTab('web-env-1', 'repo::/worktree', 'simulator-1')
    pruneDesktopCreatedServerTabs({ unifiedTabsByWorktree: {} })
    forgetDesktopCreatedServerTabsOf('repo::/worktree')
    expect(DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld('repo::/worktree', 'simulator-1')).toBe(false)
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })
})
