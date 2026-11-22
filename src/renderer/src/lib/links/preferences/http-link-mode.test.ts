import { describe, expect, it } from 'vitest'
import { httpLinkModeFor } from './http-link-mode'

describe('desktop link-open mode', () => {
  it('keeps a valid saved mode over the terminal choice', () => {
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: 'open', terminalLinkClickBehavior: 'actions' })
    ).toBe('open')
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: 'ask', terminalLinkClickBehavior: 'open' })
    ).toBe('ask')
  })

  it('asks for a missing or invalid mode only when the terminal choice is the chooser', () => {
    const invalid = 'sometimes' as unknown as 'ask'
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'actions' })).toBe('ask')
    expect(
      httpLinkModeFor({ httpLinkClickBehavior: invalid, terminalLinkClickBehavior: 'actions' })
    ).toBe('ask')
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'open' })).toBe('open')
    // "Leave to terminal app" users follow their saved browser outside the terminal.
    expect(httpLinkModeFor({ terminalLinkClickBehavior: 'none' })).toBe('open')
  })
})
