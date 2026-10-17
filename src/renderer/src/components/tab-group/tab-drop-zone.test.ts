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

  it('keeps both vertical zones when an auto-hidden strip lets the body start at the panel top', () => {
    // A short pane whose body reaches panelTop: measuring `up` from the body top would leave the
    // zone entirely inside the strip band and drop it.
    const shortPanel = { left: 0, top: 0, width: 300, height: 120 }
    const bodyRect = { left: 0, top: 0, width: 300, height: 120 }
    expect(
      resolvePaneColumnEdgeZone(
        shortPanel,
        { x: 150, y: TAB_GROUP_TAB_STRIP_HEIGHT_PX + 5 },
        {
          bodyRect
        }
      )
    ).toBe('up')
    expect(resolvePaneColumnEdgeZone(shortPanel, { x: 150, y: 115 }, { bodyRect })).toBe('down')
    expect(resolvePaneColumnEdgeZone(shortPanel, { x: 150, y: 75 }, { bodyRect })).toBeNull()
  })
})
