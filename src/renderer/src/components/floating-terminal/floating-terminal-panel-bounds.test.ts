import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anchorFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'

function stubViewport(
  width: number,
  height: number,
  userAgent = 'Macintosh',
  localStorage?: Partial<Storage>
): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height, localStorage })
  vi.stubGlobal('navigator', { userAgent })
}

describe('floating terminal panel bounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves committed size through temporary viewport shrink', () => {
    const committed = {
      anchorX: 'right' as const,
      anchorY: 'bottom' as const,
      offsetX: 40,
      offsetY: 84,
      width: 920,
      height: 560
    }

    stubViewport(520, 360)
    expect(resolveFloatingTerminalPanelBounds(committed, 'user')).toEqual({
      left: 8,
      top: 36,
      width: 504,
      height: 316
    })

    stubViewport(1200, 800)
    expect(resolveFloatingTerminalPanelBounds(committed, 'user')).toEqual({
      left: 240,
      top: 156,
      width: 920,
      height: 560
    })
  })

  it('anchors explicit left-top and right-bottom user placements by nearest edge', () => {
    stubViewport(1200, 800)

    expect(
      anchorFloatingTerminalPanelBounds({ left: 24, top: 48, width: 640, height: 360 })
    ).toEqual({
      anchorX: 'left',
      anchorY: 'top',
      offsetX: 24,
      offsetY: 48,
      width: 640,
      height: 360
    })
    expect(
      anchorFloatingTerminalPanelBounds({ left: 536, top: 336, width: 640, height: 360 })
    ).toEqual({
      anchorX: 'right',
      anchorY: 'bottom',
      offsetX: 24,
      offsetY: 104,
      width: 640,
      height: 360
    })
  })
})
