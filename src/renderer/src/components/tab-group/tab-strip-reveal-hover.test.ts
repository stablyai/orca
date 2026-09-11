import { describe, expect, it } from 'vitest'
import {
  resolveTabStripRevealHover,
  TAB_STRIP_REVEAL_HOVER_ZONE_PX
} from './tab-strip-reveal-hover'

const panelRect = { left: 100, right: 500, top: 40 }

function hover(clientX: number, clientY: number, currentlyHovered = false): boolean {
  return resolveTabStripRevealHover({ panelRect, clientX, clientY, currentlyHovered })
}

describe('resolveTabStripRevealHover', () => {
  it('reveals anywhere inside the zone below the group top edge', () => {
    expect(hover(300, 40)).toBe(true)
    expect(hover(300, 40 + TAB_STRIP_REVEAL_HOVER_ZONE_PX - 1)).toBe(true)
  })

  it('stays closed below the zone and above the group', () => {
    expect(hover(300, 40 + TAB_STRIP_REVEAL_HOVER_ZONE_PX)).toBe(false)
    expect(hover(300, 39)).toBe(false)
  })

  it('ignores a pointer in a neighbouring split column', () => {
    expect(hover(99, 45)).toBe(false)
    expect(hover(501, 45)).toBe(false)
  })

  it('holds an open strip across its full height even past the zone', () => {
    // The zone is narrower than the 32px strip, so without hysteresis the row would close under the
    // pointer while it travels toward a tab.
    expect(hover(300, 40 + 31, true)).toBe(true)
    expect(hover(300, 40 + 32, true)).toBe(false)
  })
})
