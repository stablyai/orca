import { describe, expect, it } from 'vitest'
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
})
