import { describe, expect, it } from 'vitest'
import {
  providerDiagnosticOf,
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  withProviderDiagnostic
} from './agent-session-failure'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'

describe('provider diagnostics', () => {
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
})

describe('reading a failure fact', () => {
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

  it('keeps a timed-out request through schema admission and drops one it cannot show', () => {
    const fact = {
      kind: 'startFailed',
      requestTimeout: { method: 'thread/start', timeoutMs: 30_000 }
    }
    expect(readWholeAgentSessionFailureFact(AgentSessionFailureFactSchema.parse(fact))).toEqual(
      fact
    )
    for (const requestTimeout of [
      { method: 'thread/start because of <b>', timeoutMs: 30_000 },
      { method: 'thread/start', timeoutMs: -1 },
      { method: 'thread/start' }
    ]) {
      expect(
        readWholeAgentSessionFailureFact({ kind: 'startFailed', requestTimeout })
      ).toBeUndefined()
      expect(readAgentSessionFailureFact({ kind: 'startFailed', requestTimeout })).toEqual({
        kind: 'startFailed'
      })
    }
  })

  it('keeps what a provider said it is retrying, and only that', () => {
    expect(
      readAgentSessionFailureFact({
        kind: 'providerRetrying',
        retry: { error: 'rate_limit', status: 429, retryDelayMs: 600 }
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
