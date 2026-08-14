import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalUrlOpenHint,
  terminalHttpLinkActionDestinationsFor,
  terminalUrlOpenHintOptionsFor
} from './terminal-link-open-hints'

function stubPlatform(isMac: boolean): void {
  vi.stubGlobal('navigator', { userAgent: isMac ? 'Mac OS X' : 'Windows NT 10.0' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTerminalUrlOpenHint', () => {
  it('keeps the system-browser wording by default', () => {
    stubPlatform(true)
    expect(getTerminalUrlOpenHint()).toBe(
      'Click for actions, ⌘+click to open, or ⇧⌘+click for system browser'
    )
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
      'Click for actions, ⌘+click to open, or ⇧⌘+click to open in Orca'
    )
  })

  it('uses the Ctrl chord off macOS', () => {
    stubPlatform(false)
    expect(getTerminalUrlOpenHint({ openLinksInApp: false, modifierInverts: true })).toBe(
      'Click for actions, Ctrl+click to open, or Shift+Ctrl+click to open in Orca'
    )
  })

  it('omits the action-menu gesture when terminal link actions are disabled', () => {
    stubPlatform(false)
    expect(
      getTerminalUrlOpenHint({
        openLinksInApp: false,
        modifierInverts: true,
        showActions: false
      })
    ).toBe('Ctrl+click to open, or Shift+Ctrl+click to open in Orca')
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

  // Why: a workspace-bound remote pane routes externally even with no globally
  // active runtime, so the global setting alone would advertise an impossible
  // "open in Orca" destination.
  it.each([
    ['runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' }] as const,
    ['ssh', { kind: 'ssh', connectionId: 'conn-1' }] as const,
    ['unknown', { kind: 'unknown' }] as const
  ])('drops inversion for a %s-owned pane without an active runtime', (_kind, sourceOwner) => {
    stubPlatform(true)
    const options = terminalUrlOpenHintOptionsFor(
      {
        openLinksInApp: false,
        openLinksInAppModifierInverts: true,
        activeRuntimeEnvironmentId: null
      },
      sourceOwner
    )

    expect(options.modifierInverts).toBe(false)
    expect(getTerminalUrlOpenHint(options)).toContain('for system browser')
  })

  // Why: the clicked pane's owner wins over the global runtime — a local pane
  // can still reach Orca while some other pane's runtime is active.
  it('keeps inversion for a local pane while a remote runtime is active', () => {
    stubPlatform(true)
    const options = terminalUrlOpenHintOptionsFor(
      {
        openLinksInApp: false,
        openLinksInAppModifierInverts: true,
        activeRuntimeEnvironmentId: 'remote-1'
      },
      { kind: 'local' }
    )

    expect(options.modifierInverts).toBe(true)
    expect(getTerminalUrlOpenHint(options)).toContain('to open in Orca')
  })

  it('keeps inversion for a runtime pane when its host can open an Orca browser', () => {
    const options = terminalUrlOpenHintOptionsFor(
      {
        openLinksInApp: false,
        openLinksInAppModifierInverts: true
      },
      { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
      true
    )

    expect(options.modifierInverts).toBe(true)
  })
})

describe('terminalHttpLinkActionDestinationsFor', () => {
  it('offers both destinations for a capable runtime and follows the preference', () => {
    const owner = { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const

    expect(terminalHttpLinkActionDestinationsFor({ openLinksInApp: true }, owner, true)).toEqual({
      primary: 'orca',
      alternate: 'system'
    })
    expect(terminalHttpLinkActionDestinationsFor({ openLinksInApp: false }, owner, true)).toEqual({
      primary: 'system',
      alternate: 'orca'
    })
  })

  it.each([
    ['incapable runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const],
    ['SSH', { kind: 'ssh', connectionId: 'ssh-1' } as const],
    ['unknown owner', { kind: 'unknown' } as const]
  ])('offers only the system browser for an %s', (_label, owner) => {
    expect(terminalHttpLinkActionDestinationsFor({ openLinksInApp: true }, owner, false)).toEqual({
      primary: 'system'
    })
  })
})
