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
        refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' },
        detail: { text: 'x', audience: 'person' }
      })
    ).toEqual({
      kind: 'restartFailed',
      refusal: { code: 'agent_session_conflict', cause: 'claimConflicted' },
      detail: { text: 'x', audience: 'person' }
    })
  })

  it('drops what a newer host wrote that this build cannot place', () => {
    expect(readAgentSessionFailureFact({ kind: 'futureKind' })).toBeUndefined()
    expect(readAgentSessionFailureFact(undefined)).toBeUndefined()
    expect(
      readAgentSessionFailureFact({
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', cause: 'futureCause' },
        detail: { text: 'x', audience: 'future' }
      })
    ).toEqual({ kind: 'restartFailed', refusal: { code: 'agent_session_conflict' } })
  })
})
