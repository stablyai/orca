import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS,
  AGENT_SESSION_FAILURE_KINDS,
  isSubmissionRejectionFact,
  readAgentSessionFailureFact,
  type AgentSessionFailureFact,
  type AgentSessionFailureKind,
  type SubmissionRejectionKind
} from './agent-session-failure'
import {
  agentSessionFailureSentence,
  agentSessionFailureWords,
  type AgentSessionFailureSurface
} from './agent-session-failure-words'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'

/** What Orca's own text looks like: a code or marker, a uuid, a path, an exception. */
const ORCA_INTERNAL = /\b[a-z]+_[a-z_]+\b|[0-9a-f]{8}-[0-9a-f]{4}-|[/\\][\w.-]+[/\\]|Error:|ENOENT/

const SURFACES: readonly AgentSessionFailureSurface[] = ['row', 'rejection']
const LEGACY_MARKER_KINDS: ReadonlySet<SubmissionRejectionKind> = new Set([
  'cancelled',
  'writeFailed',
  'queueFull'
])

/** Every fact shape a kind can carry: bare, with a person or a log detail, with a refusal, and
 *  for an attachment each reason with and without its limit. */
function factsFor(kind: AgentSessionFailureKind): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = [
    { kind },
    { kind, detail: { text: 'Context window exceeded.', audience: 'person' } },
    {
      kind,
      // A log detail and a refusal ride with the fact; neither may reach the sentence.
      detail: { text: 'Error: ENOENT /Users/me/.claude/x agent_session_conflict', audience: 'log' },
      refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
    }
  ]
  if (kind === 'providerRetrying') {
    facts.push({ kind, retry: { error: 'rate_limit', status: 429 } })
    facts.push({ kind, retry: { error: 'overloaded', status: 529 } })
    facts.push({ kind, retry: { status: 500 } })
  }
  if (kind === 'attachmentInvalid') {
    for (const reason of AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS) {
      facts.push({ kind, attachment: { reason } })
      facts.push({ kind, attachment: { reason, limit: 5 * 1024 * 1024 } })
    }
  }
  return facts
}

describe('the words written beside a failure fact', () => {
  describe.each(SURFACES)('on the %s surface', (surface) => {
    it.each(AGENT_SESSION_FAILURE_KINDS)('for %s are one sentence a person can read', (kind) => {
      for (const fact of factsFor(kind)) {
        for (const [agentName, command] of [
          ['Claude', undefined],
          [undefined, undefined],
          ['Codex', 'clear']
        ] as const) {
          const sentence = agentSessionFailureSentence(fact, surface, { agentName, command })
          expect([fact, sentence]).toEqual([fact, expect.stringMatching(/[^.]\.$/)])
          expect(sentence).not.toMatch(/\.\./)
          expect(sentence).not.toMatch(ORCA_INTERNAL)
          const context = { agentName, command, provider: 'claude' } as const
          if (surface === 'row') {
            expect(agentSessionFailureWords(fact, { ...context, surface }).text).toBe(sentence)
          } else if (isSubmissionRejectionFact(fact) && !LEGACY_MARKER_KINDS.has(fact.kind)) {
            expect(agentSessionFailureWords(fact, { ...context, surface }).reason).toBe(sentence)
          }
        }
      }
    })
  })

  it('writes the legacy markers released clients hide, byte for byte, on a rejection', () => {
    const reason = (kind: SubmissionRejectionKind, provider?: 'claude' | 'codex') =>
      agentSessionFailureWords({ kind }, { surface: 'rejection', provider }).reason
    expect(reason('cancelled')).toBe(DISPATCH_REJECTED_CANCELLED)
    expect(DISPATCH_REJECTED_CANCELLED).toBe('provider_cancelled_before_start')
    expect(reason('queueFull', 'claude')).toBe(DISPATCH_REJECTED_QUEUE_FULL)
    expect(DISPATCH_REJECTED_QUEUE_FULL).toBe('claude structured dispatch queue is full')
    expect(reason('queueFull', 'codex')).toBe(DISPATCH_REJECTED_CODEX_QUEUE_FULL)
    expect(DISPATCH_REJECTED_CODEX_QUEUE_FULL).toBe('codex structured dispatch queue is full')
    // Bare: the error that once followed it belongs in the log.
    expect(reason('writeFailed')).toBe(DISPATCH_REJECTED_WRITE_FAILED)
    expect(DISPATCH_REJECTED_WRITE_FAILED).toBe('provider_write_failed')
    // With no provider to name its marker, a full queue gets a sentence.
    expect(reason('queueFull')).toBe(
      'Too many messages were waiting for the agent, so this one was not sent.'
    )
    for (const kind of LEGACY_MARKER_KINDS) {
      const written = agentSessionFailureWords(
        { kind },
        { surface: 'rejection', provider: 'codex' }
      )
      expect(classifyDispatchRejection({ reason: written.reason })).toMatchObject({ kind })
    }
  })

  it('names /clear as the next step for the start a /clear needed', () => {
    const clear = (kind: AgentSessionFailureKind) =>
      agentSessionFailureSentence({ kind }, 'row', { agentName: 'Codex', command: 'clear' })
    expect(clear('notSignedIn')).toBe(
      'Codex is not signed in for the selected account. Sign in, then run /clear again.'
    )
    expect(clear('startFailed')).toBe("Codex couldn't start. Run /clear again.")
    expect(clear('restartFailed')).toBe("Codex couldn't restart. Run /clear again.")
    expect(clear('providerStartFailed')).toBe(
      'Codex stopped before it finished starting. Run /clear again.'
    )
  })

  it('names the agent that stopped starting, and a failed start or restart gives a next step', () => {
    const sentence = (kind: AgentSessionFailureKind, agentName?: string) =>
      agentSessionFailureSentence({ kind }, 'rejection', { agentName })
    expect(sentence('providerStartFailed', 'Claude')).toBe(
      'Claude stopped before it finished starting. Send your message to try again.'
    )
    expect(sentence('providerStartFailed')).toBe(
      'The agent stopped before it finished starting. Send your message to try again.'
    )
    expect(sentence('startFailed', 'Codex')).toBe(
      "Codex couldn't start. Send your message to try again."
    )
    expect(sentence('restartFailed')).toBe(
      "The agent couldn't restart. Send your message to try again."
    )
    // Nothing to restart from: a new chat is the only step, so no retry is offered.
    expect(
      agentSessionFailureSentence(
        {
          kind: 'startFailed',
          refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
        },
        'row',
        { agentName: 'Codex' }
      )
    ).toBe("Codex couldn't start. Start a new chat to continue.")
  })

  it('names the exit a row reports differently from the message it left unsent', () => {
    expect(
      agentSessionFailureWords({ kind: 'providerExited' }, { surface: 'row', agentName: 'Claude' })
        .text
    ).toBe(
      'Claude stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(
      agentSessionFailureWords(
        { kind: 'providerExited' },
        { surface: 'rejection', agentName: 'Codex' }
      ).reason
    ).toBe('Codex stopped before this message was sent.')
    expect(agentSessionFailureWords({ kind: 'providerExited' }, { surface: 'row' }).text).toBe(
      'The agent stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(
      agentSessionFailureWords({ kind: 'providerExited' }, { surface: 'rejection' }).reason
    ).toBe('The agent stopped before this message was sent.')
  })

  it('says what frees a chat a terminal agent still holds, without naming its process', () => {
    expect(
      agentSessionFailureSentence(
        {
          kind: 'restartFailed',
          refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
        },
        'row',
        { agentName: 'Codex' }
      )
    ).toBe(
      "Codex couldn't restart. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    )
  })

  it('says which limit an attachment broke, in megabytes', () => {
    const sentence = (attachment: AgentSessionFailureFact['attachment']) =>
      agentSessionFailureSentence({ kind: 'attachmentInvalid', attachment }, 'rejection', {
        agentName: 'Claude'
      })
    expect(sentence({ reason: 'tooLarge', limit: 5 * 1024 * 1024 })).toBe(
      'An image on this message is larger than 5 MB, so the message was not sent.'
    )
    expect(sentence({ reason: 'totalTooLarge', limit: 20 * 1024 * 1024 })).toBe(
      'The images on this message add up to more than 20 MB, so the message was not sent.'
    )
    expect(sentence({ reason: 'tooMany', limit: 20 })).toBe(
      'Claude accepts at most 20 images in one message, so this message was not sent.'
    )
    expect(sentence(undefined)).toBe("An attachment on this message can't be sent to the agent.")
  })
})

describe('an attachment problem as a reader meets it', () => {
  it('keeps what it can place and drops what it cannot', () => {
    expect(
      readAgentSessionFailureFact({
        kind: 'attachmentInvalid',
        attachment: { reason: 'tooMany', limit: 20 }
      })
    ).toEqual({ kind: 'attachmentInvalid', attachment: { reason: 'tooMany', limit: 20 } })
    expect(
      readAgentSessionFailureFact({
        kind: 'attachmentInvalid',
        attachment: { reason: 'tooMany', limit: 'twenty' }
      })
    ).toEqual({ kind: 'attachmentInvalid', attachment: { reason: 'tooMany' } })
    // A reason a newer host added reads as the generic attachment failure.
    expect(
      readAgentSessionFailureFact({
        kind: 'attachmentInvalid',
        attachment: { reason: 'futureReason' }
      })
    ).toEqual({ kind: 'attachmentInvalid' })
  })
})
