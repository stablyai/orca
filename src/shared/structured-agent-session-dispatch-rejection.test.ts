import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED,
  DISPATCH_REJECTED_QUEUE_FULL,
  isWriteFailureSubmission
} from './structured-agent-session-dispatch-rejection'

describe('classifyDispatchRejection', () => {
  it.each([
    [DISPATCH_REJECTED_CANCELLED, 'withdrawn', null, 'cancelled'],
    [DISPATCH_REJECTED_HOST_RESTARTED, 'undelivered', null, 'hostRestarted'],
    [DISPATCH_REJECTED_PROVIDER_CLOSED, 'undelivered', null, 'chatClosed'],
    ['not_delivered', 'undelivered', null, 'notDelivered'],
    [DISPATCH_REJECTED_QUEUE_FULL, 'transport', 'failure', 'queueFull'],
    [DISPATCH_REJECTED_CODEX_QUEUE_FULL, 'transport', 'failure', 'queueFull'],
    ['provider_write_failed: broken pipe', 'transport', 'failure', 'writeFailed'],
    ['provider_write_failed', 'transport', 'failure', 'writeFailed']
  ] as const)('reads the legacy marker %j', (reason, category, verdict, kind) => {
    expect(classifyDispatchRejection({ reason })).toEqual({ category, verdict, kind })
  })

  it.each([
    ['cancelled', 'withdrawn', null],
    ['hostRestarted', 'undelivered', null],
    ['chatClosed', 'undelivered', null],
    ['notDelivered', 'undelivered', null],
    ['providerResumeUnavailable', 'startFailed', 'failure'],
    // Orca stopped a start that hung: the agent failed, and the message never reached it.
    ['hostStopped', 'undelivered', 'failure'],
    ['writeFailed', 'transport', 'failure'],
    ['queueFull', 'transport', 'failure'],
    // The chat's state refused a queued command when its turn to run came.
    ['commandRefused', 'content', 'failure']
  ] as const)('reads the written %s rejection as %s, verdict %s', (kind, category, verdict) => {
    const written = agentSessionFailureWords(agentSessionFailureFact(kind), {
      surface: 'rejection',
      provider: 'claude'
    })
    expect(classifyDispatchRejection(written)).toEqual({ category, verdict, kind })
  })

  it('reads the typed fact over the sentence beside it', () => {
    expect(
      classifyDispatchRejection({
        reason: 'The provider stopped before it finished starting.',
        rejection: { kind: 'providerStartFailed' }
      })
    ).toEqual({ category: 'startFailed', verdict: 'failure', kind: 'providerStartFailed' })
    expect(
      classifyDispatchRejection({ reason: 'Not sent.', rejection: { kind: 'queueFull' } })
    ).toMatchObject({ category: 'transport', verdict: 'failure' })
  })

  it('writes a sentence, not a marker released clients would print, for a restart or a close', () => {
    for (const kind of ['hostRestarted', 'chatClosed'] as const) {
      const written = agentSessionFailureWords(agentSessionFailureFact(kind), {
        surface: 'rejection'
      })
      expect(written.reason).not.toMatch(/^[a-z_]+$/)
      expect(classifyDispatchRejection(written)).toEqual({
        category: 'undelivered',
        verdict: null,
        kind
      })
    }
  })

  it('gives a fact it cannot place no verdict, whatever the reason beside it says', () => {
    // A newer host's kind, a status-row kind, and a fact with no kind at all.
    for (const rejection of [{ kind: 'futureKind' }, { kind: 'providerRetrying' }, {}]) {
      for (const reason of [
        DISPATCH_REJECTED_QUEUE_FULL,
        DISPATCH_REJECTED_CANCELLED,
        'Refused.'
      ]) {
        expect(classifyDispatchRejection({ reason, rejection })).toEqual({
          category: 'undelivered',
          verdict: null
        })
      }
    }
  })
})

describe('isWriteFailureSubmission', () => {
  it('holds for a legacy row in any state that carries the marker', () => {
    expect(
      isWriteFailureSubmission({ reason: 'provider_write_failed: closed before enqueue' })
    ).toBe(true)
  })

  it('holds for the bare marker a new host writes, as released clients already read it', () => {
    const written = agentSessionFailureWords(agentSessionFailureFact('writeFailed'), {
      surface: 'rejection'
    })
    expect(written.reason).toBe('provider_write_failed')
    expect(isWriteFailureSubmission({ reason: written.reason })).toBe(true)
  })

  it('holds for a typed write failure and for nothing else', () => {
    expect(isWriteFailureSubmission({ reason: 'x', rejection: { kind: 'writeFailed' } })).toBe(true)
    expect(isWriteFailureSubmission({ reason: DISPATCH_REJECTED_QUEUE_FULL })).toBe(false)
    expect(isWriteFailureSubmission({ reason: 'x', rejection: { kind: 'queueFull' } })).toBe(false)
    expect(isWriteFailureSubmission({ reason: null })).toBe(false)
  })
})
