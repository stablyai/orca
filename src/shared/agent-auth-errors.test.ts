import { describe, expect, it } from 'vitest'
import { isAgentAuthError } from './agent-auth-errors'

describe('isAgentAuthError', () => {
  it('matches known Claude login/reauth phrasings', () => {
    expect(
      isAgentAuthError('claude', 'Please run `/login` in Claude Code to enroll this device.')
    ).toBe(true)
    expect(
      isAgentAuthError(
        'claude',
        'Remote Control disconnected — Your organization requires Trusted Devices for Remote Control, but this device is not enrolled.'
      )
    ).toBe(true)
    expect(isAgentAuthError('claude', 'You are not logged in.')).toBe(true)
    expect(isAgentAuthError('claude', 'Ran into a network timeout fetching the file.')).toBe(false)
  })

  it('defers to the Codex auth-error patterns for codex', () => {
    expect(isAgentAuthError('codex', 'Sign in with ChatGPT')).toBe(true)
    expect(isAgentAuthError('codex', 'plain provider error')).toBe(false)
  })

  it('never matches for agents without a pattern table, or empty/null text', () => {
    expect(isAgentAuthError('grok', 'not logged in')).toBe(false)
    expect(isAgentAuthError('omp', 'run /login')).toBe(false)
    expect(isAgentAuthError('claude', null)).toBe(false)
    expect(isAgentAuthError('claude', '   ')).toBe(false)
    expect(isAgentAuthError(null, 'not logged in')).toBe(false)
  })
})
