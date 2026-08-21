import { describe, expect, it } from 'vitest'
import {
  normalizeOsc52ClipboardDefaultOn,
  osc52ClipboardDefaultOnOverridesPersistedOff
} from './osc52-clipboard-settings'

describe('normalizeOsc52ClipboardDefaultOn', () => {
  it('flips an unstamped profile on, because its `false` came from the old default', () => {
    // Why: every profile saved before #10567 persisted `false`, which the settings
    // merge then wins with — indistinguishable on disk from a deliberate opt-out.
    expect(normalizeOsc52ClipboardDefaultOn({ terminalAllowOsc52Clipboard: false })).toEqual({
      terminalAllowOsc52Clipboard: true,
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
    })
  })

  it('leaves a stamped opt-out off', () => {
    expect(
      normalizeOsc52ClipboardDefaultOn({
        terminalAllowOsc52Clipboard: false,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      })
    ).toEqual({
      terminalAllowOsc52Clipboard: false,
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
    })
  })

  it('defaults a fresh or absent profile on', () => {
    for (const settings of [
      undefined,
      {},
      { terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true }
    ]) {
      expect(normalizeOsc52ClipboardDefaultOn(settings)).toEqual({
        terminalAllowOsc52Clipboard: true,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      })
    }
  })

  it('is idempotent, so a crash before the write-back cannot re-flip an opt-out', () => {
    const once = normalizeOsc52ClipboardDefaultOn({ terminalAllowOsc52Clipboard: false })
    expect(normalizeOsc52ClipboardDefaultOn(once)).toEqual(once)

    const optedOut = normalizeOsc52ClipboardDefaultOn({
      terminalAllowOsc52Clipboard: false,
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
    })
    expect(normalizeOsc52ClipboardDefaultOn(optedOut)).toEqual(optedOut)
  })
})

describe('osc52ClipboardDefaultOnOverridesPersistedOff', () => {
  it('is true only when the migration overrides a persisted off', () => {
    expect(
      osc52ClipboardDefaultOnOverridesPersistedOff({ terminalAllowOsc52Clipboard: false })
    ).toBe(true)
  })

  it('is false for a fresh profile, which has no persisted value to override', () => {
    // Why: a notice here would nag every new install about a setting they never touched.
    expect(osc52ClipboardDefaultOnOverridesPersistedOff(undefined)).toBe(false)
    expect(osc52ClipboardDefaultOnOverridesPersistedOff({})).toBe(false)
    expect(
      osc52ClipboardDefaultOnOverridesPersistedOff({ terminalAllowOsc52Clipboard: true })
    ).toBe(false)
  })

  it('is false once stamped, because a stamped value is honored rather than overridden', () => {
    expect(
      osc52ClipboardDefaultOnOverridesPersistedOff({
        terminalAllowOsc52Clipboard: false,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      })
    ).toBe(false)
  })
})
