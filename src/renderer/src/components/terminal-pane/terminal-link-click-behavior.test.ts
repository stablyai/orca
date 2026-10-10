import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { terminalLinkClickBehaviorFor } from './terminal-link-click-behavior'

describe('terminalLinkClickBehaviorFor', () => {
  it('defaults to actions and preserves legacy profiles', () => {
    expect(terminalLinkClickBehaviorFor(undefined)).toBe('actions')
    expect(terminalLinkClickBehaviorFor({ terminalLinkActionPopoverEnabled: true })).toBe('actions')
    expect(terminalLinkClickBehaviorFor({ terminalLinkActionPopoverEnabled: false })).toBe('none')
  })

  it('prefers the explicit behavior for new profiles', () => {
    expect(
      terminalLinkClickBehaviorFor({
        terminalLinkActionPopoverEnabled: false,
        terminalLinkClickBehavior: 'open'
      })
    ).toBe('open')
    expect(terminalLinkClickBehaviorFor({ terminalLinkClickBehavior: 'none' })).toBe('none')
  })

  it('returns the explicit actions behavior even when the legacy flag is false', () => {
    expect(
      terminalLinkClickBehaviorFor({
        terminalLinkActionPopoverEnabled: false,
        terminalLinkClickBehavior: 'actions'
      })
    ).toBe('actions')
  })

  it('keeps the legacy opt-out when defaults inject actions into a stored profile', () => {
    // Mirrors the real load chain: normalize-loaded-global-settings spreads
    // defaults.settings beneath the parsed profile, so a legacy profile that
    // stored only terminalLinkActionPopoverEnabled: false (no
    // terminalLinkClickBehavior on disk) arrives here with the default
    // injected. The legacy opt-out must still win.
    const loadedLegacyProfile = {
      ...getDefaultSettings('/tmp'),
      terminalLinkActionPopoverEnabled: false
    }
    expect(terminalLinkClickBehaviorFor(loadedLegacyProfile)).toBe('none')
  })
})
