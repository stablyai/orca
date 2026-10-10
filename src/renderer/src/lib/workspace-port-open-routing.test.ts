import { describe, expect, it } from 'vitest'
import {
  getPortOpenBrowserTooltipLabel,
  resolvePortOpenModifierDestination,
  resolvePortOpenRouting
} from './workspace-port-open-routing'

function clickEvent(overrides: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  return { metaKey: false, ctrlKey: false, shiftKey: false, ...overrides }
}

const INVERTING = { openLinksInApp: false, openLinksInAppModifierInverts: true }

describe('resolvePortOpenModifierDestination', () => {
  it('names the system browser on a remote port, whose plain click always stays in Orca', () => {
    expect(
      resolvePortOpenModifierDestination({
        settings: { openLinksInApp: false },
        remoteHost: true,
        systemBrowserAvailable: true
      })
    ).toBe('system-browser')
  })

  it('still names the system browser on a remote port for users who inverted the modifier', () => {
    expect(
      resolvePortOpenModifierDestination({
        settings: INVERTING,
        remoteHost: true,
        systemBrowserAvailable: true
      })
    ).toBe('system-browser')
  })

  it('offers nothing on a remote port with no client-reachable address, inverted or not', () => {
    expect(
      resolvePortOpenModifierDestination({
        settings: { openLinksInApp: false },
        remoteHost: true,
        systemBrowserAvailable: false
      })
    ).toBeNull()
    expect(
      resolvePortOpenModifierDestination({
        settings: INVERTING,
        remoteHost: true,
        systemBrowserAvailable: false
      })
    ).toBeNull()
  })

  it('offers nothing on a local port whose plain click already opens the system browser', () => {
    expect(
      resolvePortOpenModifierDestination({ settings: { openLinksInApp: false }, remoteHost: false })
    ).toBeNull()
  })

  it('names Orca only where inverting makes the modifier the way back into the app', () => {
    expect(resolvePortOpenModifierDestination({ settings: INVERTING, remoteHost: false })).toBe(
      'orca'
    )
  })

  it('names the system browser on a local port that opens in Orca by setting', () => {
    expect(
      resolvePortOpenModifierDestination({ settings: { openLinksInApp: true }, remoteHost: false })
    ).toBe('system-browser')
  })
})

describe('resolvePortOpenRouting', () => {
  it('separates the stock plain click from an explicit system-browser request', () => {
    expect(
      resolvePortOpenRouting({
        settings: { openLinksInApp: false },
        remoteHost: true,
        systemBrowserAvailable: true,
        event: clickEvent(),
        isMac: true
      })
    ).toEqual({ openInOrcaBrowser: false, systemBrowserRequested: false })
    expect(
      resolvePortOpenRouting({
        settings: { openLinksInApp: false },
        remoteHost: true,
        systemBrowserAvailable: true,
        event: clickEvent({ metaKey: true, shiftKey: true }),
        isMac: true
      })
    ).toEqual({ openInOrcaBrowser: false, systemBrowserRequested: true })
  })

  it('reaches the system browser on a remote port even with the modifier inverted', () => {
    expect(
      resolvePortOpenRouting({
        settings: INVERTING,
        remoteHost: true,
        systemBrowserAvailable: true,
        event: clickEvent({ ctrlKey: true, shiftKey: true }),
        isMac: false
      })
    ).toEqual({ openInOrcaBrowser: false, systemBrowserRequested: true })
  })

  it('keeps an unreachable remote port in the embedded browser under the modifier', () => {
    expect(
      resolvePortOpenRouting({
        settings: { openLinksInApp: false },
        remoteHost: true,
        systemBrowserAvailable: false,
        event: clickEvent({ metaKey: true, shiftKey: true }),
        isMac: true
      })
    ).toEqual({ openInOrcaBrowser: false, systemBrowserRequested: false })
  })

  it('sends the modifier to Orca on a local port for users who inverted it', () => {
    expect(
      resolvePortOpenRouting({
        settings: INVERTING,
        remoteHost: false,
        event: clickEvent({ ctrlKey: true, shiftKey: true }),
        isMac: false
      })
    ).toEqual({ openInOrcaBrowser: true, systemBrowserRequested: false })
  })

  it('keeps no-pointer activations on the saved setting', () => {
    expect(
      resolvePortOpenRouting({ settings: { openLinksInApp: true }, event: null, isMac: true })
    ).toEqual({ openInOrcaBrowser: true, systemBrowserRequested: false })
  })
})

describe('getPortOpenBrowserTooltipLabel', () => {
  it('advertises the modifier when the system browser can serve the port', () => {
    expect(
      getPortOpenBrowserTooltipLabel('Open in Browser', {
        isMac: true,
        modifierDestination: resolvePortOpenModifierDestination({
          settings: { openLinksInApp: false },
          remoteHost: true,
          systemBrowserAvailable: true
        })
      })
    ).toBe('Open in Browser. ⇧⌘+click for system browser')
  })

  it('drops the hint when no reachable address exists, rather than promising a no-op', () => {
    expect(
      getPortOpenBrowserTooltipLabel('Open in Browser', {
        isMac: true,
        modifierDestination: resolvePortOpenModifierDestination({
          settings: INVERTING,
          remoteHost: true,
          systemBrowserAvailable: false
        })
      })
    ).toBe('Open in Browser')
  })

  it('names Orca for an inverting user on a local port, instead of the system browser', () => {
    expect(
      getPortOpenBrowserTooltipLabel('Open in Browser', {
        isMac: false,
        modifierDestination: resolvePortOpenModifierDestination({
          settings: INVERTING,
          remoteHost: false
        })
      })
    ).toBe('Open in Browser. Shift+Ctrl+click to open in Orca')
  })
})
