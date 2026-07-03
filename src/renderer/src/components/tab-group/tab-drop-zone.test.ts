import { describe, expect, it } from 'vitest'
import { resolvePaneColumnEdgeZone, TAB_GROUP_TAB_STRIP_HEIGHT_PX } from './tab-drop-zone'

describe('resolvePaneColumnEdgeZone', () => {
  const panelRect = { left: 0, top: 0, width: 300, height: 200 }

  it('returns right on the outer horizontal band in the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 260, y: 100 })).toBe('right')
  })

  it('returns null in the center band of the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 150, y: 100 })).toBeNull()
  })

  it('does not return up while the pointer is still in the tab strip', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX - 1
      })
    ).toBeNull()
  })

  it('returns up on the top edge of the pane body', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX + 5
      })
    ).toBe('up')
  })
})
