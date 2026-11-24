import { describe, expect, it } from 'vitest'
import { httpLinkActionDestinationsFor } from '@/lib/browser/navigation/http-link-destinations'
import { httpLinkModeFor, httpLinkModeForLink, plainClickDestinationsFor } from './http-link-mode'

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

  it('opens a local localhost link in Orca without asking; other links keep the setting', () => {
    const settings = { httpLinkClickBehavior: 'ask', openLinksInApp: false } as const
    const local = { kind: 'local' } as const
    const localhost = 'http://localhost:5173/app'
    const destinations = httpLinkActionDestinationsFor(settings, local, false, localhost)
    // The setting's order stays for middle-click "open"; plain and Cmd/Ctrl-click put Orca first.
    expect(destinations.primary).toBe('system')
    expect(plainClickDestinationsFor(destinations)).toMatchObject({
      primary: 'orca',
      alternate: 'system'
    })
    expect(httpLinkModeForLink(settings, destinations)).toBe('open')
    expect(httpLinkModeForLink(settings, plainClickDestinationsFor(destinations))).toBe('open')

    const web = 'https://example.com/'
    const webDestinations = httpLinkActionDestinationsFor(settings, local, false, web)
    expect(plainClickDestinationsFor(webDestinations)).toBe(webDestinations)
    expect(httpLinkModeForLink(settings, webDestinations)).toBe('ask')

    // Stage 1: an SSH host's loopback keeps its existing rules (under Ask, the chooser), routed or not.
    const ssh = { kind: 'ssh', connectionId: 'c1' } as const
    const sshDestinations = httpLinkActionDestinationsFor(settings, ssh, true, localhost)
    expect(httpLinkModeForLink(settings, sshDestinations)).toBe('ask')
    expect(plainClickDestinationsFor(sshDestinations)).toBe(sshDestinations)
  })
})
