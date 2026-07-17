import { describe, expect, it, vi } from 'vitest'
import {
  RIGHT_SIDEBAR_EDGE_PEEK_SETTING_ID,
  RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS,
  getRightSidebarEdgePeekSettingsLinkLabel,
  getRightSidebarEdgePeekTipTitle,
  markRightSidebarEdgePeekTipDismissed,
  openRightSidebarEdgePeekSetting,
  shouldShowRightSidebarEdgePeekTip
} from './right-sidebar-edge-peek-tip'

describe('shouldShowRightSidebarEdgePeekTip', () => {
  it('shows only when edge peek is enabled and the tip is not dismissed', () => {
    expect(shouldShowRightSidebarEdgePeekTip(null)).toBe(true)
    expect(
      shouldShowRightSidebarEdgePeekTip({
        rightSidebarEdgePeekEnabled: true,
        rightSidebarEdgePeekTipDismissed: false
      })
    ).toBe(true)
    expect(
      shouldShowRightSidebarEdgePeekTip({
        rightSidebarEdgePeekEnabled: false
      })
    ).toBe(false)
    expect(
      shouldShowRightSidebarEdgePeekTip({
        rightSidebarEdgePeekTipDismissed: true
      })
    ).toBe(false)
  })
})

describe('markRightSidebarEdgePeekTipDismissed', () => {
  it('persists the one-shot dismiss flag', () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    markRightSidebarEdgePeekTipDismissed({ updateSettings })
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarEdgePeekTipDismissed: true })
  })
})

describe('tip copy', () => {
  it('describes the edge gesture and links into Settings', () => {
    expect(getRightSidebarEdgePeekTipTitle()).toContain('right edge')
    expect(getRightSidebarEdgePeekSettingsLinkLabel()).toBe('Settings')
  })
})

describe('openRightSidebarEdgePeekSetting', () => {
  it('opens Appearance with the edge-peek section and seeds search', () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const setSettingsSearchQuery = vi.fn()
    openRightSidebarEdgePeekSetting({
      openSettingsPage,
      openSettingsTarget,
      setSettingsSearchQuery
    })
    expect(setSettingsSearchQuery).toHaveBeenCalled()
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'appearance',
      repoId: null,
      sectionId: RIGHT_SIDEBAR_EDGE_PEEK_SETTING_ID
    })
    expect(openSettingsPage).toHaveBeenCalled()
  })
})

describe('RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS', () => {
  it('stays brief (tooltip-length, not toast-length)', () => {
    expect(RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS).toBeLessThanOrEqual(3000)
    expect(RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS).toBeGreaterThanOrEqual(1000)
  })
})
