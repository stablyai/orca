import { describe, expect, it } from 'vitest'
import { shouldCloseActivityPageOnEscapeKey } from './activity-escape-close'

describe('activity Escape close handling', () => {
  it('closes for unhandled Escape from Activity chrome', () => {
    expect(shouldCloseActivityPageOnEscapeKey({ key: 'Escape', defaultPrevented: false }, {})).toBe(
      true
    )
  })

  it('ignores already-handled Escape and non-Escape keys', () => {
    expect(shouldCloseActivityPageOnEscapeKey({ key: 'Escape', defaultPrevented: true }, {})).toBe(
      false
    )
    expect(shouldCloseActivityPageOnEscapeKey({ key: 'Enter', defaultPrevented: false }, {})).toBe(
      false
    )
  })

  it('does not close when the Activity terminal owns focus', () => {
    const xtermElement = {
      classList: {
        contains: (token: string) => token === 'xterm-helper-textarea'
      }
    }

    expect(
      shouldCloseActivityPageOnEscapeKey({ key: 'Escape', defaultPrevented: false }, xtermElement)
    ).toBe(false)
  })

  it('does not close when focus is inside the Activity terminal portal', () => {
    const portalElement = {
      closest: (selector: string) => (selector === '[data-activity-terminal-slot-id]' ? {} : null)
    }

    expect(
      shouldCloseActivityPageOnEscapeKey({ key: 'Escape', defaultPrevented: false }, portalElement)
    ).toBe(false)
  })
})
