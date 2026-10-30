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

  // When links already open in Orca, inversion must advertise the system browser.
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

  // Remote-ineligible routes must not promise Orca when clicking opens externally.
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

  // Workspace-bound remote ownership can forbid Orca even without a global active runtime.
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

  // Pane ownership beats global runtime selection; another remote pane cannot disable local Orca links.
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

  it('keeps inversion for an eligible SSH pane', () => {
    const options = terminalUrlOpenHintOptionsFor(
      {
        openLinksInApp: false,
        openLinksInAppModifierInverts: true
      },
      { kind: 'ssh', connectionId: 'ssh-1' },
      true
    )

    expect(options.modifierInverts).toBe(true)
  })
})
