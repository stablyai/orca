import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTerminalUrlOpenHint, terminalUrlOpenHintOptionsFor } from './terminal-link-open-hints'

function stubPlatform(isMac: boolean): void {
  vi.stubGlobal('navigator', { userAgent: isMac ? 'Mac OS X' : 'Windows NT 10.0' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTerminalUrlOpenHint', () => {
  it('keeps the system-browser wording by default', () => {
    stubPlatform(true)
    expect(getTerminalUrlOpenHint()).toBe('⌘+click to open or ⇧⌘+click for system browser')
  })

  it('keeps the system-browser wording when inverting is off', () => {
    stubPlatform(true)
    expect(getTerminalUrlOpenHint({ openLinksInApp: false, modifierInverts: false })).toContain(
      'for system browser'
    )
  })

  // Why: with links already opening in Orca, inverting still lands on the system
  // browser, so the hint must not promise Orca.
  it('keeps the system-browser wording when inverting but links open in Orca', () => {
    stubPlatform(true)
    expect(getTerminalUrlOpenHint({ openLinksInApp: true, modifierInverts: true })).toContain(
      'for system browser'
    )
  })

  it('names Orca when inverting and links open externally', () => {
    stubPlatform(true)
    expect(getTerminalUrlOpenHint({ openLinksInApp: false, modifierInverts: true })).toBe(
      '⌘+click to open or ⇧⌘+click to open in Orca'
    )
  })

  it('uses the Ctrl chord off macOS', () => {
    stubPlatform(false)
    expect(getTerminalUrlOpenHint({ openLinksInApp: false, modifierInverts: true })).toBe(
      'Ctrl+click to open or Shift+Ctrl+click to open in Orca'
    )
  })
})

describe('terminalUrlOpenHintOptionsFor', () => {
  it('reports inversion when links open externally on a local runtime', () => {
    expect(
      terminalUrlOpenHintOptionsFor({
        openLinksInApp: false,
        openLinksInAppModifierInverts: true
      })
    ).toEqual({ openLinksInApp: false, modifierInverts: true })
  })

  // Why: openHttpLink refuses to route a remote-owned URL into Orca, so promising
  // "open in Orca" there would advertise a click that lands somewhere else.
  it('drops inversion while a remote runtime is active', () => {
    stubPlatform(true)
    const options = terminalUrlOpenHintOptionsFor({
      openLinksInApp: false,
      openLinksInAppModifierInverts: true,
      activeRuntimeEnvironmentId: 'remote-1'
    })

    expect(options.modifierInverts).toBe(false)
    expect(getTerminalUrlOpenHint(options)).toContain('for system browser')
  })

  it('ignores a blank runtime id', () => {
    expect(
      terminalUrlOpenHintOptionsFor({
        openLinksInApp: false,
        openLinksInAppModifierInverts: true,
        activeRuntimeEnvironmentId: '   '
      }).modifierInverts
    ).toBe(true)
  })

  it('tolerates missing settings', () => {
    expect(terminalUrlOpenHintOptionsFor(null)).toEqual({
      openLinksInApp: false,
      modifierInverts: false
    })
  })
})
