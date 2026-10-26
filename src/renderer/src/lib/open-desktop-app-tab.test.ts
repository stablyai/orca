import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ensure-simulator-tab', () => ({ createLiveSurfaceTabRightOf: vi.fn() }))

import { canOpenDesktopAppTab, isMacDesktopAppHost } from './open-desktop-app-tab'

function stubHost(
  platform: string | null,
  displayServer: 'wayland' | 'x11' | null = null,
  hasDesktopApp = true
): void {
  vi.stubGlobal('window', {
    api: {
      desktopApp: hasDesktopApp ? {} : undefined,
      platform: platform === null ? undefined : { get: () => ({ platform, displayServer }) }
    }
  })
}

describe('canOpenDesktopAppTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['darwin', 'win32'])('offers the tab on %s', (platform) => {
    stubHost(platform)
    expect(canOpenDesktopAppTab()).toBe(true)
  })

  it('offers the tab on Linux only under X11', () => {
    stubHost('linux', 'x11')
    expect(canOpenDesktopAppTab()).toBe(true)
    stubHost('linux', 'wayland')
    expect(canOpenDesktopAppTab()).toBe(false)
    stubHost('linux', null)
    expect(canOpenDesktopAppTab()).toBe(false)
  })

  it('hides the tab without the desktop app bridge', () => {
    stubHost('darwin', null, false)
    expect(canOpenDesktopAppTab()).toBe(false)
  })

  it('falls back to the user agent when the platform API is missing', () => {
    stubHost(null)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(canOpenDesktopAppTab()).toBe(true)
    expect(isMacDesktopAppHost()).toBe(true)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(canOpenDesktopAppTab()).toBe(false)
  })

  it('reports the Mac host from the platform API', () => {
    stubHost('win32')
    expect(isMacDesktopAppHost()).toBe(false)
    stubHost('darwin')
    expect(isMacDesktopAppHost()).toBe(true)
  })
})
