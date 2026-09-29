import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  parseAgentSessionWriteFailure,
  readAgentSessionErrorRefusal
} from './agent-session-write-failure'

const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'

function saved(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('parseAgentSessionWriteFailure', () => {
  // The shape saved before refusals carried a reason; it loads as it was and reads as its code.
  it('reads back an entry saved with the code alone, unchanged', () => {
    expect(
      parseAgentSessionWriteFailure(saved({ kind: 'refused', code: 'agent_session_conflict' }))
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
    expect(parseAgentSessionWriteFailure({ kind: 'failed' })).toEqual({ kind: 'failed' })
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_conflict',
        message: HOST_TEXT
      })
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
  })

  it.each([
    [
      'a reason',
      { kind: 'refused', code: 'agent_session_conflict', details: { reason: 'chatStarting' } }
    ],
    [
      "a rewind's reason",
      {
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'rewindRefused', rewindReason: 'busy' }
      }
    ],
    [
      "the owner's verdict",
      {
        kind: 'refused',
        code: 'agent_session_ownership_unknown',
        details: { reason: 'ownerUnproven', ownerVerdict: 'exited' }
      }
    ]
  ])('keeps %s', (_label, value) => {
    expect(parseAgentSessionWriteFailure(saved(value))).toEqual(value)
  })

  // A newer build's reason or verdict is dropped, never guessed; the code's words stand.
  it.each([
    [{ reason: 'fromTheFuture' }, undefined],
    [{ reason: 'fromTheFuture', ownerVerdict: 'exited' }, { ownerVerdict: 'exited' }],
    [{ reason: 'ownerUnproven', ownerVerdict: 'gone' }, { reason: 'ownerUnproven' }],
    [{ reason: 'chatStarting' }, undefined]
  ])('drops what this build cannot place: %j', (details, kept) => {
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_ownership_unknown',
        details
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_ownership_unknown',
      ...(kept ? { details: kept } : {})
    })
  })

  it.each([
    null,
    'The agent was restarting.',
    { kind: 'refused' },
    { kind: 'refused', code: 'agent_session_from_the_future' },
    { kind: 'something-else' }
  ])('drops %j instead of guessing', (value) => {
    expect(parseAgentSessionWriteFailure(value)).toBeUndefined()
  })
})

describe('agentSessionRefusalFailure', () => {
  // What moves with the owner, the question's answer and the host's words are never kept.
  it('keeps only the facts that stay true after a reload', () => {
    expect(
      agentSessionRefusalFailure({
        code: 'agent_session_checkpoint_stale',
        details: { reason: 'fenceStale', currentFence: 3, ownerVerdict: 'exited' }
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_checkpoint_stale',
      details: { reason: 'fenceStale' }
    })
    // A prompt's revision and winning answer, and a provider's diagnostic, as a host may send them.
    const answered = JSON.parse(
      JSON.stringify({
        code: 'agent_session_already_resolved',
        details: {
          reason: 'promptAlreadyResolved',
          currentRevision: 2,
          resolution: { state: 'answered', selectedOptionId: 'yes', resolvedBy: 'phone' },
          detail: { text: 'stderr', audience: 'log' }
        }
      })
    )
    expect(agentSessionRefusalFailure(answered)).toEqual({
      kind: 'refused',
      code: 'agent_session_already_resolved',
      details: { reason: 'promptAlreadyResolved' }
    })
  })

  it('keeps a code from a newer host without reading its details', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","details":{"reason":"x"}}')
    expect(agentSessionRefusalFailure(refusal)).toEqual({
      kind: 'refused',
      code: 'agent_session_from_the_future'
    })
  })
})

describe('a refusal a failed request carried in its error', () => {
  const refusal = {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalCorrupt', stray: 'dropped' }
  }
  const payload = { code: 'runtime_error', message: 'agent_session_journal_unreadable' }

  it('is read from a thrown RPC error and from a stream payload alike', () => {
    const expected = {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    }
    expect(
      readAgentSessionErrorRefusal({ response: { error: { ...payload, data: { refusal } } } })
    ).toEqual(expected)
    expect(readAgentSessionErrorRefusal(saved({ ...payload, data: { refusal } }))).toEqual(expected)
  })

  it.each([
    ['an older host', payload],
    ['a thrown error without a response', new Error('agent_session_journal_unreadable')],
    ['a code this build does not know', { ...payload, data: { refusal: { code: 'from_later' } } }],
    ['nothing', undefined]
  ])('is absent from %s', (_label, error) => {
    expect(readAgentSessionErrorRefusal(error)).toBeUndefined()
  })

  it("words the refusal when there is one, else what the request's error code proves", () => {
    expect(agentSessionThrownFailure({ ...payload, data: { refusal } }, 'runtime_error')).toEqual({
      kind: 'refused',
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
    expect(agentSessionThrownFailure(payload, 'runtime_error')).toEqual({ kind: 'unconfirmed' })
    expect(agentSessionThrownFailure(payload, 'method_not_found')).toEqual({
      kind: 'refused',
      code: 'structured_agent_session_unsupported'
    })
  })
})
