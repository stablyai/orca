import { describe, expect, it } from 'vitest'
import {
  isRightSidebarEdgePeekEnabled,
  isRightSidebarEdgePeekTipDismissed
} from './right-sidebar-edge-peek-preference'

describe('isRightSidebarEdgePeekEnabled', () => {
  it('defaults on when settings are missing or the flag is absent', () => {
    expect(isRightSidebarEdgePeekEnabled(null)).toBe(true)
    expect(isRightSidebarEdgePeekEnabled(undefined)).toBe(true)
    expect(isRightSidebarEdgePeekEnabled({})).toBe(true)
  })

  it('respects an explicit opt-out', () => {
    expect(isRightSidebarEdgePeekEnabled({ rightSidebarEdgePeekEnabled: false })).toBe(false)
    expect(isRightSidebarEdgePeekEnabled({ rightSidebarEdgePeekEnabled: true })).toBe(true)
  })
})

describe('isRightSidebarEdgePeekTipDismissed', () => {
  it('defaults to not dismissed', () => {
    expect(isRightSidebarEdgePeekTipDismissed(null)).toBe(false)
    expect(isRightSidebarEdgePeekTipDismissed({})).toBe(false)
  })

  it('returns true only for an explicit dismiss', () => {
    expect(isRightSidebarEdgePeekTipDismissed({ rightSidebarEdgePeekTipDismissed: true })).toBe(
      true
    )
    expect(isRightSidebarEdgePeekTipDismissed({ rightSidebarEdgePeekTipDismissed: false })).toBe(
      false
    )
  })
})
