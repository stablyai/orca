import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic,
  providerDiagnosticOf,
  agentSessionFailureFact,
  readAgentSessionFailureFact,
  readProviderRetry,
  readWholeAgentSessionFailureFact,
  withProviderDiagnostic
} from './agent-session-failure'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import { AGENT_SESSION_REFUSAL_REASONS } from './agent-session-refusal-details'

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

  it('retains safe argument details through schema admission and falls back for unknown details', () => {
    const fact = {
      kind: 'startFailed',
      argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
    }
    expect(readWholeAgentSessionFailureFact(AgentSessionFailureFactSchema.parse(fact))).toEqual(
      fact
    )
    expect(readWholeAgentSessionFailureFact({ kind: 'startFailed' })).toEqual({
      kind: 'startFailed'
    })
    for (const argumentProblem of [
      { agent: 'Future', option: '--remote', problem: 'unsupportedOption' },
      { agent: 'Codex', option: '--remote', problem: 'futureProblem' },
      { agent: 'Codex', option: '--remote=private', problem: 'unsupportedOption' }
    ]) {
      expect(
        readWholeAgentSessionFailureFact({ kind: 'startFailed', argumentProblem })
      ).toBeUndefined()
      expect(readAgentSessionFailureFact({ kind: 'startFailed', argumentProblem })).toEqual({
        kind: 'startFailed'
      })
    }
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
    // The provider's own account of what failed survives a read, bounded like any detail.
    expect(
      readAgentSessionFailureFact({
        kind: 'providerRetrying',
        retry: { cause: `  stream disconnected${' x'.repeat(400)}` }
      })?.retry?.cause
    ).toBe(`stream disconnected${' x'.repeat(400)}`.slice(0, 512).trim())
    expect(
      readAgentSessionFailureFact({ kind: 'providerRetrying', retry: { cause: '  ' } })
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

describe('reading all of a failure fact', () => {
  it('reads every part of a fact the host built, as it arrives off the wire', () => {
    for (const fact of [
      agentSessionFailureFact('startFailed', {
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
      }),
      agentSessionFailureFact('providerRejected', {
        detail: providerDiagnostic('Image type .bmp', 'person')
      }),
      agentSessionFailureFact('attachmentInvalid', {
        attachment: { reason: 'tooLarge', limit: 5 * 1024 * 1024 }
      }),
      agentSessionFailureFact('providerRetrying', {
        retry: readProviderRetry({ error: 'rate_limit', status: 429 })
      })
    ]) {
      expect(readWholeAgentSessionFailureFact(JSON.parse(JSON.stringify(fact)))).toEqual(fact)
    }
    // Every reason a refusal can name, on the code that names it.
    for (const [code, reasons] of Object.entries(AGENT_SESSION_REFUSAL_REASONS)) {
      for (const reason of reasons) {
        const fact = { kind: 'startFailed', refusal: { code, details: { reason } } }
        expect(readWholeAgentSessionFailureFact(fact)).toEqual(fact)
      }
    }
  })

  it('reads nothing when this build would drop any part, however deep', () => {
    for (const value of [
      { kind: 'futureKind' },
      { kind: 'startFailed', refusal: { code: 'agent_session_future_code' } },
      {
        kind: 'startFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'futureReason' } }
      },
      { kind: 'attachmentInvalid', attachment: { reason: 'futureReason' } },
      { kind: 'providerRejected', detail: { text: 'x', audience: 'future' } },
      { kind: 'startFailed', futurePart: {} }
    ]) {
      expect(readWholeAgentSessionFailureFact(value)).toBeUndefined()
    }
  })
})
