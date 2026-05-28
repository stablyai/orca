import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TITLEBAR_SAFE_TOP,
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds
} from './floating-terminal-panel-bounds'

function stubViewport(width: number, height: number, userAgent: string): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height })
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
})
