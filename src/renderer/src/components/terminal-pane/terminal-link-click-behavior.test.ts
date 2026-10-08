import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { terminalLinkClickBehaviorFor } from './terminal-link-click-behavior'

describe('terminalLinkClickBehaviorFor', () => {
  it('defaults to actions before settings load', () => {
    expect(terminalLinkClickBehaviorFor(undefined)).toBe('actions')
    expect(terminalLinkClickBehaviorFor({})).toBe('actions')
  })

  it('returns the stored behavior', () => {
    expect(terminalLinkClickBehaviorFor({ terminalLinkClickBehavior: 'open' })).toBe('open')
    expect(terminalLinkClickBehaviorFor({ terminalLinkClickBehavior: 'none' })).toBe('none')
  })

  it('honors re-enabled actions even when the legacy opt-out is still stored', () => {
    const settings: Partial<GlobalSettings> = {
      terminalLinkActionPopoverEnabled: false,
      terminalLinkClickBehavior: 'actions'
    }
    expect(terminalLinkClickBehaviorFor(settings)).toBe('actions')
  })
})
