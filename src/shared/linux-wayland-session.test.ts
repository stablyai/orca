import { describe, expect, it } from 'vitest'
import { isLinuxWaylandSession } from './linux-wayland-session'

describe('native Wayland session', () => {
  it.each([
    { WAYLAND_DISPLAY: 'wayland-1' },
    { XDG_SESSION_TYPE: 'wayland' },
    { ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }
  ])('recognizes the session from %j', (env) => {
    expect(isLinuxWaylandSession({ platform: 'linux', env })).toBe(true)
  })
  it('recognizes a command-line Wayland backend without a session hint', () => {
    expect(isLinuxWaylandSession({ platform: 'linux', env: {}, ozonePlatform: 'wayland' })).toBe(
      true
    )
  })
  it('honors explicit X11 overrides on Wayland desktops', () => {
    const env = { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland' }
    expect(isLinuxWaylandSession({ platform: 'linux', env, ozonePlatform: 'x11' })).toBe(false)
    expect(
      isLinuxWaylandSession({
        platform: 'linux',
        env: { ...env, ELECTRON_OZONE_PLATFORM_HINT: 'x11' }
      })
    ).toBe(false)
    expect(
      isLinuxWaylandSession({
        platform: 'linux',
        env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
        ozonePlatform: 'wayland'
      })
    ).toBe(true)
  })
  it.each(['darwin', 'win32', 'linux'] as const)(
    'keeps ordinary %s sessions on their existing backend',
    (platform) => {
      expect(isLinuxWaylandSession({ platform, env: {} })).toBe(false)
    }
  )
})
