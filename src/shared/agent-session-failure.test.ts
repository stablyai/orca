import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic,
  providerDiagnosticOf,
  readAgentSessionFailureFact,
  withProviderDiagnostic
} from './agent-session-failure'

describe('provider diagnostics', () => {
  it('bounds the text and records nothing for an empty one', () => {
    expect(providerDiagnostic('  ', 'log')).toBeUndefined()
    expect(
      providerDiagnostic('x'.repeat(MAX_PROVIDER_DIAGNOSTIC_CHARS + 50), 'log')?.text
    ).toHaveLength(MAX_PROVIDER_DIAGNOSTIC_CHARS)
  })

  it('is read from the error that carries it, or from what it wraps', () => {
    const diagnostic = { text: 'bad request', audience: 'person' as const }
    const carried = withProviderDiagnostic(
      new Error('codex turn/start failed: bad request'),
      diagnostic
    )
    expect(providerDiagnosticOf(carried)).toEqual(diagnostic)
    expect(providerDiagnosticOf(new Error('wrapped', { cause: carried }))).toEqual(diagnostic)
    expect(providerDiagnosticOf(new AggregateError([new Error('other'), carried], 'both'))).toEqual(
      diagnostic
    )
  })

  it('ends on an aggregate error that contains itself', () => {
    const loop = new AggregateError([], 'loop')
    loop.errors.push(loop)
    expect(providerDiagnosticOf(loop)).toBeUndefined()
  })

  it('is never inferred from an error that did not carry one', () => {
    // Orca's own wording, even when it quotes something that looks like a provider message.
    expect(
      providerDiagnosticOf(new Error('claude stream-json exited (code 1): not signed in'))
    ).toBe(undefined)
    expect(providerDiagnosticOf('a string')).toBeUndefined()
  })
})

describe('reading a failure fact', () => {
  it('keeps what this build can place', () => {
    expect(
      readAgentSessionFailureFact({
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } },
        detail: { text: 'x', audience: 'person' }
      })
    ).toEqual({
      kind: 'restartFailed',
      refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } },
      detail: { text: 'x', audience: 'person' }
    })
  })

  it('keeps what a provider said it is retrying, and only that', () => {
    expect(
      readAgentSessionFailureFact({
        kind: 'providerRetrying',
        retry: { error: 'rate_limit', status: 429, attempt: 3 }
      })
    ).toEqual({ kind: 'providerRetrying', retry: { error: 'rate_limit', status: 429 } })
    expect(
      readAgentSessionFailureFact({ kind: 'providerRetrying', retry: { error: '', status: 'x' } })
    ).toEqual({ kind: 'providerRetrying' })
  })

  it('reads a row an unreleased build wrote with a cause as a refusal with no details', () => {
    expect(
      readAgentSessionFailureFact({
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' }
      })
    ).toEqual({ kind: 'restartFailed', refusal: { code: 'agent_session_conflict' } })
  })

  it('drops what a newer host wrote that this build cannot place', () => {
    expect(readAgentSessionFailureFact({ kind: 'futureKind' })).toBeUndefined()
    expect(readAgentSessionFailureFact(undefined)).toBeUndefined()
    expect(
      readAgentSessionFailureFact({
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'futureReason' } },
        detail: { text: 'x', audience: 'future' }
      })
    ).toEqual({ kind: 'restartFailed', refusal: { code: 'agent_session_conflict' } })
  })
})
