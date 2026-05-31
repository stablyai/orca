import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  TITLEBAR_SAFE_TOP,
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  hasUsableFloatingTerminalPanelViewport,
  parseFloatingTerminalPanelBounds,
  persistFloatingTerminalPanelBounds,
  readPersistedFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelBounds,
  shouldReconcileFloatingTerminalPanelBounds
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

  it('lets dragged panels touch the macOS titlebar without going above it', () => {
    stubViewport(1200, 800, 'Macintosh')

    const bounds = clampFloatingTerminalBounds({
      left: 32,
      top: 8,
      width: 640,
      height: 360
    })

    expect(bounds.top).toBe(TITLEBAR_SAFE_TOP)
  })

  it('keeps dragged panels below the renderer titlebar on other platforms', () => {
    stubViewport(1200, 800, 'Windows NT')

    const bounds = clampFloatingTerminalBounds({
      left: 32,
      top: 8,
      width: 640,
      height: 360
    })

    expect(bounds.top).toBe(TITLEBAR_SAFE_TOP)
  })

  it('maximizes below the renderer titlebar on non-mac platforms', () => {
    stubViewport(1200, 800, 'Windows NT')

    expect(getMaximizedFloatingTerminalBounds()).toEqual(
      expect.objectContaining({
        top: TITLEBAR_SAFE_TOP,
        height: 800 - TITLEBAR_SAFE_TOP - 36
      })
    )
  })

  it('defaults at or below the titlebar on compact macOS windows', () => {
    stubViewport(760, 420, 'Macintosh')

    expect(getDefaultFloatingTerminalBounds().top).toBeGreaterThanOrEqual(TITLEBAR_SAFE_TOP)
  })

  it('parses only complete finite persisted bounds', () => {
    expect(
      parseFloatingTerminalPanelBounds('{"left":12,"top":36,"width":700,"height":400}')
    ).toEqual({
      left: 12,
      top: 36,
      width: 700,
      height: 400
    })
    expect(parseFloatingTerminalPanelBounds('not-json')).toBeNull()
    expect(parseFloatingTerminalPanelBounds('{"left":12,"top":36,"width":700}')).toBeNull()
    expect(
      parseFloatingTerminalPanelBounds('{"left":12,"top":36,"width":700,"height":null}')
    ).toBeNull()
  })

  it('falls back when persisted storage is malformed or unavailable', () => {
    const localStorage = {
      getItem: vi.fn(() => '{"left":"bad","top":36,"width":700,"height":400}'),
      setItem: vi.fn()
    }
    stubViewport(1200, 800, 'Macintosh', localStorage)

    expect(readPersistedFloatingTerminalPanelBounds()).toBeNull()

    localStorage.getItem.mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readPersistedFloatingTerminalPanelBounds()).toBeNull()

    localStorage.setItem.mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() =>
      persistFloatingTerminalPanelBounds({ left: 20, top: 40, width: 700, height: 400 })
    ).not.toThrow()
  })

  it('persists bounds through the panel-specific storage key', () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    }
    stubViewport(1200, 800, 'Macintosh', localStorage)

    persistFloatingTerminalPanelBounds({ left: 20, top: 40, width: 700, height: 400 })

    expect(localStorage.setItem).toHaveBeenCalledWith(
      FLOATING_TERMINAL_PANEL_BOUNDS_STORAGE_KEY,
      '{"left":20,"top":40,"width":700,"height":400}'
    )
  })

  it('shrinks oversized saved bounds while keeping a viewport margin', () => {
    stubViewport(800, 600)

    expect(
      clampFloatingTerminalBounds({
        left: 2000,
        top: 1200,
        width: 1200,
        height: 900
      })
    ).toEqual({
      left: 8,
      top: TITLEBAR_SAFE_TOP,
      width: 784,
      height: 556
    })
  })

  it('keeps the top-left reachable when the viewport is smaller than the minimum panel', () => {
    stubViewport(300, 260)

    expect(
      clampFloatingTerminalBounds({
        left: 200,
        top: 200,
        width: 900,
        height: 500
      })
    ).toEqual({
      left: 8,
      top: TITLEBAR_SAFE_TOP,
      width: MIN_PANEL_WIDTH,
      height: MIN_PANEL_HEIGHT
    })
  })

  it('re-anchors default bounds and clamps user bounds by source', () => {
    stubViewport(0, 0)
    const initialBounds = getDefaultFloatingTerminalBounds()

    stubViewport(1200, 800)
    expect(resolveFloatingTerminalPanelBounds(initialBounds, 'default')).toEqual(
      getDefaultFloatingTerminalBounds()
    )
    expect(
      resolveFloatingTerminalPanelBounds({ left: 900, top: 500, width: 720, height: 480 }, 'user')
    ).toEqual({ left: 472, top: 312, width: 720, height: 480 })
  })

  it('defers user-bound reconciliation until the viewport is usable', () => {
    stubViewport(0, 0)

    expect(hasUsableFloatingTerminalPanelViewport()).toBe(false)
    expect(shouldReconcileFloatingTerminalPanelBounds('default')).toBe(true)
    expect(shouldReconcileFloatingTerminalPanelBounds('user')).toBe(false)

    stubViewport(640, 480)
    expect(hasUsableFloatingTerminalPanelViewport()).toBe(true)
    expect(shouldReconcileFloatingTerminalPanelBounds('user')).toBe(true)
  })
})
