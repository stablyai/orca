import { describe, expect, it } from 'vitest'
import {
  isOfficeRefreshClickable,
  isTerminalOfficeRefusal,
  officeRefreshState,
  type OfficeRefreshInputs
} from './office-preview-refresh-state'

function inputs(overrides: Partial<OfficeRefreshInputs> = {}): OfficeRefreshInputs {
  return {
    renderable: true,
    terminallyRefused: false,
    addressable: true,
    changedOnDisk: false,
    busy: false,
    ...overrides
  }
}

describe('office refresh state', () => {
  it('is idle when nothing is known to have changed', () => {
    expect(officeRefreshState(inputs())).toBe('idle')
    expect(isOfficeRefreshClickable('idle')).toBe(true)
  })

  it('turns updated when the document changed on disk', () => {
    expect(officeRefreshState(inputs({ changedOnDisk: true }))).toBe('updated')
    expect(isOfficeRefreshClickable('updated')).toBe(true)
  })

  it('hides itself when re-rendering cannot change the outcome', () => {
    expect(officeRefreshState(inputs({ renderable: false }))).toBe('hidden')
    expect(officeRefreshState(inputs({ terminallyRefused: true, changedOnDisk: true }))).toBe(
      'hidden'
    )
  })

  it('disables rather than lies while busy or unaddressable', () => {
    expect(officeRefreshState(inputs({ busy: true, changedOnDisk: true }))).toBe('disabled')
    expect(officeRefreshState(inputs({ addressable: false }))).toBe('disabled')
    expect(isOfficeRefreshClickable('disabled')).toBe(false)
    expect(isOfficeRefreshClickable('hidden')).toBe(false)
  })

  it('keeps a missing binary retryable', () => {
    // Installing it and pressing Retry is exactly the recovery the missing-binary notice offers,
    // so hiding the control there would remove the way out.
    expect(isTerminalOfficeRefusal('OFFICECLI_NOT_FOUND')).toBe(false)
    expect(isTerminalOfficeRefusal('OFFICECLI_RENDER_FAILED')).toBe(false)
    expect(isTerminalOfficeRefusal('OFFICECLI_UNSUPPORTED_FORMAT')).toBe(true)
    expect(isTerminalOfficeRefusal('OFFICE_RENDER_TOO_LARGE')).toBe(true)
    expect(isTerminalOfficeRefusal(null)).toBe(false)
  })
})
