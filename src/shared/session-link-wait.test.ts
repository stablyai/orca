import { testOrcaSessionId } from './orca-session-address-test-fixture'
import { describe, expect, it } from 'vitest'
import { SessionLinkEvent } from './session-link'
import { sessionLinkNextMessage, sessionLinkWaitingFor } from './session-link-wait'

const event = (id: string, fields: Partial<SessionLinkEvent>) =>
  SessionLinkEvent.parse({
    id,
    linkId: 'pair',
    actor: 'codex-work',
    recipient: testOrcaSessionId('claude-review'),
    kind: 'checkpoint',
    state: 'accepted',
    messageId: id,
    operationId: id,
    createdAt: 1,
    replyTo: null,
    detail: '',
    body: id,
    ...fields
  })

describe('checkpoint correlation', () => {
  it('holds unrelated status while accepting a clarification, then only a correlated accepted reply releases the checkpoint', () => {
    const checkpoint = event('ready', {})
    const status = event('status', {
      actor: 'claude-review',
      recipient: testOrcaSessionId('codex-work'),
      kind: 'message',
      state: 'queued'
    })
    const clarification = event('clarify', {
      actor: 'claude-review',
      recipient: testOrcaSessionId('codex-work'),
      kind: 'question',
      state: 'queued'
    })
    const reply = event('decision', {
      actor: 'claude-review',
      recipient: testOrcaSessionId('codex-work'),
      kind: 'reply',
      replyTo: 'ready',
      state: 'queued'
    })
    expect(sessionLinkNextMessage([checkpoint, status], 'codex-work')).toBeUndefined()
    expect(sessionLinkNextMessage([checkpoint, status, clarification], 'codex-work')?.id).toBe(
      'clarify'
    )
    expect(sessionLinkNextMessage([checkpoint, status, reply], 'codex-work')?.id).toBe('decision')
    expect(sessionLinkWaitingFor([checkpoint, reply], 'codex-work')?.id).toBe('ready')
    expect(
      sessionLinkWaitingFor([checkpoint, { ...reply, state: 'accepted' }], 'codex-work')
    ).toBeNull()
    expect(
      sessionLinkNextMessage([checkpoint, { ...reply, state: 'accepted' }, status], 'codex-work')
        ?.id
    ).toBe('status')
  })
  it('does not let an old reply release a new checkpoint', () => {
    expect(
      sessionLinkWaitingFor(
        [
          event('old', {}),
          event('new', {}),
          event('reply', {
            actor: 'claude-review',
            recipient: testOrcaSessionId('codex-work'),
            kind: 'reply',
            replyTo: 'old'
          })
        ],
        'codex-work'
      )?.id
    ).toBe('new')
  })
})
