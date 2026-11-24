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

  it('opens a reachable localhost link in Orca without asking; other links keep the setting', () => {
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

    // An SSH host's loopback opens directly only when its tab is routed through that host.
    const ssh = { kind: 'ssh', connectionId: 'c1' } as const
    const routed = httpLinkActionDestinationsFor(settings, ssh, true, localhost, true)
    expect(httpLinkModeForLink(settings, routed)).toBe('open')
    // "This device" browses from here, where the host's localhost is not reachable: keep asking.
    const thisDevice = httpLinkActionDestinationsFor(settings, ssh, true, localhost, false)
    expect(httpLinkModeForLink(settings, thisDevice)).toBe('ask')
    expect(plainClickDestinationsFor(thisDevice)).toBe(thisDevice)
  })
})
