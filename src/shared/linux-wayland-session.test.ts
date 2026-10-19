import { describe, expect, it } from 'vitest'
import { isLinuxWaylandSession } from './linux-wayland-session'

describe('native Wayland session', () => {
  it.each([{ WAYLAND_DISPLAY: 'wayland-1' }, { XDG_SESSION_TYPE: 'wayland' }])(
    'recognizes the session from %j',
    (env) => {
      expect(isLinuxWaylandSession({ platform: 'linux', env })).toBe(true)
    }
  )
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
        env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
        ozonePlatform: 'wayland'
      })
    ).toBe(true)
  })
  it('ignores the environment hint removed in Electron 38', () => {
    expect(
      isLinuxWaylandSession({
        platform: 'linux',
        env: { XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'x11' }
      })
    ).toBe(true)
    expect(
      isLinuxWaylandSession({
        platform: 'linux',
        env: { ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }
      })
    ).toBe(false)
  })
  it.each(['x11', 'headless'])(
    'honors the explicit %s backend despite Wayland variables',
    (ozonePlatform) => {
      expect(
        isLinuxWaylandSession({
          platform: 'linux',
          env: { WAYLAND_DISPLAY: 'wayland-1' },
          ozonePlatform
        })
      ).toBe(false)
    }
  )
  it.each([
    ['wayland', true],
    ['x11', false],
    ['tty', false],
    [undefined, false]
  ] as const)(
    'uses session type %s for automatic selection despite a Wayland socket',
    (session, expected) => {
      expect(
        isLinuxWaylandSession({
          platform: 'linux',
          env: { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: session },
          ozonePlatform: 'auto'
        })
      ).toBe(expected)
    }
  )
  it.each(['darwin', 'win32'] as const)(
    'never selects Wayland on %s despite Linux environment variables and switches',
    (platform) => {
      for (const ozonePlatform of ['', 'auto', 'wayland']) {
        expect(
          isLinuxWaylandSession({
            platform,
            env: { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland' },
            ozonePlatform
          })
        ).toBe(false)
      }
    }
  )
  it.each(['darwin', 'win32', 'linux'] as const)(
    'keeps ordinary %s sessions on their existing backend',
    (platform) => {
      expect(isLinuxWaylandSession({ platform, env: {} })).toBe(false)
    }
  )
})
