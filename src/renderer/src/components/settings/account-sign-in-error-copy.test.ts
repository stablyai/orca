import { describe, expect, it } from 'vitest'
import {
  getClaudeAccountErrorDescription,
  getCodexAccountErrorDescription,
  isClaudeAccountCancellation
} from './account-sign-in-error-copy'

describe('getCodexAccountErrorDescription', () => {
  it('shows only the reason behind the IPC envelope', () => {
    expect(
      getCodexAccountErrorDescription(
        new Error("Error invoking remote method 'codexAccounts:login': Error: Seat limit reached")
      )
    ).toBe('Seat limit reached')
  })

  // Why: the previous regex was scoped to the codexAccounts channel, so a rejection that
  // reached this toast from any other channel kept its wrapper on screen.
  it('strips the envelope whatever channel it names', () => {
    expect(
      getCodexAccountErrorDescription(
        new Error("Error invoking remote method 'settings:update': Error: Seat limit reached")
      )
    ).toBe('Seat limit reached')
  })

  it('still maps a known auth failure that arrived wrapped', () => {
    expect(
      getCodexAccountErrorDescription(
        new Error("Error invoking remote method 'codexAccounts:login': Error: Auth error 502")
      )
    ).toBe('Codex sign-in is temporarily unavailable. Please try again in a minute.')
  })

  it('still unwraps the codex login prefix behind the envelope', () => {
    expect(
      getCodexAccountErrorDescription(
        new Error(
          "Error invoking remote method 'codexAccounts:login': Error: Codex login failed: bad token"
        )
      )
    ).toBe('bad token')
  })

  it('falls back when the envelope carried no reason', () => {
    expect(
      getCodexAccountErrorDescription(
        new Error("Error invoking remote method 'codexAccounts:login': Error")
      )
    ).toBe('Codex sign-in failed. Please try again.')
  })

  it('keeps trimming a bare Error: prefix that never crossed IPC', () => {
    expect(getCodexAccountErrorDescription(new Error('Error: Seat limit reached'))).toBe(
      'Seat limit reached'
    )
  })
})

describe('getClaudeAccountErrorDescription', () => {
  it('shows only the reason behind the IPC envelope', () => {
    expect(
      getClaudeAccountErrorDescription(
        new Error("Error invoking remote method 'claudeAccounts:login': Error: Token expired")
      )
    ).toBe('Token expired')
  })

  it('strips the envelope whatever channel it names', () => {
    expect(
      getClaudeAccountErrorDescription(
        new Error("Error invoking remote method 'settings:update': Error: Token expired")
      )
    ).toBe('Token expired')
  })

  it('falls back when the envelope carried no reason', () => {
    expect(
      getClaudeAccountErrorDescription(
        new Error("Error invoking remote method 'claudeAccounts:login': Error")
      )
    ).toBe('Claude sign-in failed. Please try again.')
  })
})

describe('isClaudeAccountCancellation', () => {
  // Why: cancellation is matched on the stripped text, so the envelope must be gone before
  // the comparison — otherwise a cancelled sign-in raises an error toast.
  it('recognizes a cancellation that arrived inside the envelope', () => {
    expect(
      isClaudeAccountCancellation(
        new Error(
          "Error invoking remote method 'claudeAccounts:login': Error: Claude sign-in was cancelled."
        )
      )
    ).toBe(true)
  })

  it('does not treat an unrelated failure as a cancellation', () => {
    expect(
      isClaudeAccountCancellation(
        new Error("Error invoking remote method 'claudeAccounts:login': Error: Token expired")
      )
    ).toBe(false)
  })
})
