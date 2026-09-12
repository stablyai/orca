import { describe, expect, it } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { shouldShowUnexpectedSignoutCard } from './unexpected-signout-visibility'

function reconnectRequired(): OrcaProfileAuthStatus {
  return {
    activeProfileId: 'profile-1',
    configured: true,
    state: 'reconnect-required',
    persistence: 'none',
    cloud: {
      cloudProfileId: 'cloud-1',
      userId: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      linkedAt: 0
    }
  }
}

describe('shouldShowUnexpectedSignoutCard', () => {
  it.each([
    { name: 'unknown auth', auth: null, visible: false },
    {
      name: 'missing cloud link',
      auth: { ...reconnectRequired(), cloud: undefined },
      visible: false
    },
    {
      name: 'unconfigured linked profile',
      auth: { ...reconnectRequired(), configured: false, state: 'unconfigured' },
      visible: false
    },
    {
      name: 'unconfigured reconnect status',
      auth: { ...reconnectRequired(), configured: false },
      visible: false
    },
    {
      name: 'local with stale cloud metadata',
      auth: { ...reconnectRequired(), state: 'local' },
      visible: false
    },
    {
      name: 'live memory-only session',
      auth: { ...reconnectRequired(), state: 'connected', persistence: 'memory-only' },
      visible: false
    },
    {
      name: 'decrypt failure with retained link',
      auth: { ...reconnectRequired(), credentialError: 'Cannot decrypt' },
      visible: true
    },
    {
      name: 'unreadable session with retained link',
      auth: { ...reconnectRequired(), credentialError: 'Permission denied' },
      visible: true
    }
  ] satisfies { name: string; auth: OrcaProfileAuthStatus | null; visible: boolean }[])(
    '$name',
    ({ auth, visible }) => {
      expect(
        shouldShowUnexpectedSignoutCard({
          authStatus: auth,
          persistedUIReady: true,
          appVersion: '1.4.197',
          dismissedVersion: null
        })
      ).toBe(visible)
    }
  )

  it('shows when linked but the session is gone', () => {
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: reconnectRequired(),
        persistedUIReady: true,
        appVersion: '1.4.197',
        dismissedVersion: null
      })
    ).toBe(true)
  })

  it('hides after an explicit sign-out (link removed)', () => {
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: {
          activeProfileId: 'profile-1',
          configured: true,
          state: 'local',
          persistence: 'none'
        },
        persistedUIReady: true,
        appVersion: '1.4.197',
        dismissedVersion: null
      })
    ).toBe(false)
  })

  it('hides when connected', () => {
    const status = reconnectRequired()
    status.state = 'connected'
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: status,
        persistedUIReady: true,
        appVersion: '1.4.197',
        dismissedVersion: null
      })
    ).toBe(false)
  })

  it('shows only once per app version', () => {
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: reconnectRequired(),
        persistedUIReady: true,
        appVersion: '1.4.197',
        dismissedVersion: '1.4.197'
      })
    ).toBe(false)
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: reconnectRequired(),
        persistedUIReady: true,
        appVersion: '1.4.198',
        dismissedVersion: '1.4.197'
      })
    ).toBe(true)
  })

  it('waits for hydration and version', () => {
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: reconnectRequired(),
        persistedUIReady: false,
        appVersion: '1.4.197',
        dismissedVersion: null
      })
    ).toBe(false)
    expect(
      shouldShowUnexpectedSignoutCard({
        authStatus: reconnectRequired(),
        persistedUIReady: true,
        appVersion: null,
        dismissedVersion: null
      })
    ).toBe(false)
  })
})
