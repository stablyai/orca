import { describe, expect, it } from 'vitest'
import {
  describeBrowserLoadFailure,
  formatBrowserLoadFailureText,
  isBrowserNetworkLoadFailure,
  type BrowserLoadFailureRoute
} from './browser-load-failure'

const DIRECT: BrowserLoadFailureRoute = { routed: false }
const SSH_UP: BrowserLoadFailureRoute = { routed: true, routeConnected: true }
const SSH_DOWN: BrowserLoadFailureRoute = { routed: true, routeConnected: false }

function english(
  code: number,
  url: string,
  route: BrowserLoadFailureRoute | null = DIRECT,
  description = 'ERR_X'
) {
  const loadError = { code, description, validatedUrl: url }
  const failure = describeBrowserLoadFailure(loadError, route)
  const text = formatBrowserLoadFailureText(loadError, failure)
  return { ...text, kind: failure.kind, recovery: failure.recovery }
}

describe('describeBrowserLoadFailure', () => {
  it.each([
    // A dev server that isn't up yet waits for it, wherever the developer runs it.
    [-102, 'http://localhost:3000/', DIRECT, 'Nothing is running on localhost:3000 yet', 'poll'],
    [-102, 'http://127.0.0.1:5173/', DIRECT, 'Nothing is running on 127.0.0.1:5173 yet', 'poll'],
    [
      -102,
      'http://192.168.1.20:8080/',
      DIRECT,
      'Nothing is running on 192.168.1.20:8080 yet',
      'poll'
    ],
    [-102, 'http://app.test/', DIRECT, 'Nothing is running on app.test yet', 'poll'],
    [-102, 'http://[::1]:4000/', DIRECT, 'Nothing is running on [::1]:4000 yet', 'poll'],
    // A public site that refused may come back too, but it isn't "your" server.
    [-102, 'https://example.com/', DIRECT, 'example.com refused to connect', 'poll'],
    [-105, 'https://example.com/', DIRECT, "Couldn't find example.com", null],
    [-105, 'http://printer.local/', DIRECT, "Couldn't find printer.local", 'poll'],
    [-106, 'https://example.com/', DIRECT, "You're offline", 'online'],
    [-118, 'http://localhost:3000/', DIRECT, 'localhost:3000 took too long to respond', 'poll'],
    [-101, 'https://example.com/', DIRECT, 'The connection to example.com was interrupted', null],
    // An extension's blocking rule: reloading can't help until the site is allowed.
    [-20, 'https://ads.example.com/', DIRECT, 'ads.example.com is blocked', null],
    // Through the SSH route every failure is -120; the host's state says which one it was.
    [-120, 'http://localhost:3000/', SSH_UP, 'Nothing is running on localhost:3000 yet', 'poll'],
    [-120, 'http://localhost:3000/', SSH_DOWN, "Can't reach the SSH host", 'poll'],
    [-120, 'https://example.com/', SSH_DOWN, "Can't reach the SSH host", 'poll'],
    [-120, 'https://example.com/', SSH_UP, "Can't reach example.com", null],
    // A caller that can't see the route (the phone) doesn't guess.
    [-120, 'http://localhost:3000/', null, "Can't reach localhost:3000", 'poll']
  ])('code %i on %s (%o) reads "%s" and recovers by %s', (code, url, route, title, recovery) => {
    const result = english(code, url, route)
    expect(result.title).toBe(title)
    expect(result.recovery).toBe(recovery)
  })

  it("keeps Orca's own messages (code 0) as they are", () => {
    expect(
      english(0, 'https://example.com/', DIRECT, 'Unsupported browser URL: foo').description
    ).toBe('Unsupported browser URL: foo')
    expect(english(0, 'https://example.com/').recovery).toBeNull()
  })

  it('names the Chromium error for the developer line only when there is one', () => {
    const named = { code: -102, description: 'ERR_CONNECTION_REFUSED', validatedUrl: 'http://a/' }
    const synthesized = {
      code: -1,
      description: 'This site could not be reached.',
      validatedUrl: 'http://a/'
    }
    expect(describeBrowserLoadFailure(named, DIRECT).errorName).toBe('ERR_CONNECTION_REFUSED')
    expect(describeBrowserLoadFailure(synthesized, DIRECT).errorName).toBeNull()
  })

  it('leaves certificate and Orca-coded failures to their own pages on mobile', () => {
    const at = (code: number) => ({ code, description: '', validatedUrl: 'https://a/' })
    expect(isBrowserNetworkLoadFailure(at(-102))).toBe(true)
    expect(isBrowserNetworkLoadFailure(at(-202))).toBe(false)
    expect(isBrowserNetworkLoadFailure(at(-10_000))).toBe(false)
    expect(isBrowserNetworkLoadFailure(at(0))).toBe(false)
  })
})
