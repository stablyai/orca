import { describe, expect, it } from 'vitest'
import { httpLinkActionDestinationsFor } from '@/lib/browser/navigation/http-link-destinations'
import { httpLinkModeFor, httpLinkModeForLink } from './http-link-mode'

describe('desktop link-open mode', () => {
  it('keeps a valid saved mode over the terminal choice', () => {
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: 'open', terminalLinkClickBehavior: 'actions' })
    ).toBe('open')
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: 'ask', terminalLinkClickBehavior: 'open' })
    ).toBe('ask')
  })

  it('asks for a missing or invalid mode only when the terminal choice is the chooser', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an out-of-range stored value, as an older or corrupt profile could hold.
    const invalid = 'sometimes' as unknown as 'ask'
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'actions' })).toBe('ask')
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: invalid, terminalLinkClickBehavior: 'actions' })
    ).toBe('ask')
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'open' })).toBe('open')
    // "Leave to terminal app" users follow their saved browser outside the terminal.
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'none' })).toBe('open')
  })

  it('opens a localhost link in Orca without asking, and leaves other links to the setting', () => {
    const settings = { httpLinkClickBehavior: 'ask', openLinksInApp: false } as const
    const local = { kind: 'local' } as const
    const localhost = 'http://localhost:5173/app'
    const destinations = httpLinkActionDestinationsFor(settings, local, false, localhost)
    expect(destinations).toEqual({ primary: 'orca', alternate: 'system' })
    expect(httpLinkModeForLink(settings, localhost, destinations)).toBe('open')

    const web = 'https://example.com/'
    const webDestinations = httpLinkActionDestinationsFor(settings, local, false, web)
    expect(webDestinations.primary).toBe('system')
    expect(httpLinkModeForLink(settings, web, webDestinations)).toBe('ask')

    // A remote source that cannot reach Orca's browser keeps asking with its one destination.
    const remote = { kind: 'ssh', connectionId: 'c1' } as const
    const remoteDestinations = httpLinkActionDestinationsFor(settings, remote, false, localhost)
    expect(remoteDestinations).toEqual({ primary: 'system' })
    expect(httpLinkModeForLink(settings, localhost, remoteDestinations)).toBe('ask')
  })
})
