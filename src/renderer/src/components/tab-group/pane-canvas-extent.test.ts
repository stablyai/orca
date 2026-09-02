import { describe, expect, it } from 'vitest'
import { collectVisiblePaneCanvasTerminalIds, paneCanvasExtent } from './pane-canvas-extent'

describe('pane canvas extent', () => {
  it('grows beyond the viewport to retain off-screen cards', () => {
    expect(
      paneCanvasExtent(['far'], { far: { x: 1400, y: 900, width: 480, height: 320 } }, 1280, 800)
    ).toEqual({ width: 1888, height: 1228 })
  })

  it('ignores retained bounds for sessions outside the current scope', () => {
    expect(
      paneCanvasExtent(
        ['active'],
        {
          active: { x: 20, y: 20, width: 480, height: 320 },
          dormant: { x: 5000, y: 4000, width: 480, height: 320 }
        },
        1280,
        800
      )
    ).toEqual({ width: 1280, height: 800 })
  })

  it('reports only cards intersecting the viewport margin', () => {
    const visible = collectVisiblePaneCanvasTerminalIds(
      ['onscreen', 'nearby', 'offscreen'],
      {
        onscreen: { x: 20, y: 20, width: 320, height: 220 },
        nearby: { x: 920, y: 20, width: 320, height: 220 },
        offscreen: { x: 1400, y: 20, width: 320, height: 220 }
      },
      { scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600 },
      128
    )

    expect([...visible]).toEqual(['onscreen', 'nearby'])
  })

  it('updates visibility after scrolling without treating every canvas card as foreground', () => {
    const bounds = {
      first: { x: 20, y: 20, width: 320, height: 220 },
      second: { x: 20, y: 900, width: 320, height: 220 }
    }

    expect(
      collectVisiblePaneCanvasTerminalIds(
        ['first', 'second'],
        bounds,
        { scrollLeft: 0, scrollTop: 760, clientWidth: 800, clientHeight: 600 },
        64
      )
    ).toEqual(new Set(['second']))
  })
})
