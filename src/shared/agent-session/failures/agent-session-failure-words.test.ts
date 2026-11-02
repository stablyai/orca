import { describe, expect, it } from 'vitest'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact,
  type SubmissionRejectionKind
} from './agent-session-failure'
import {
  agentSessionFailureSentence,
  agentSessionFailureWords
} from './agent-session-failure-words'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from '../requests/structured-agent-session-dispatch-rejection'

const LEGACY_MARKER_KINDS: ReadonlySet<SubmissionRejectionKind> = new Set([
  'cancelled',
  'writeFailed',
  'queueFull'
])

describe('the words written beside a failure fact', () => {
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

  it("quotes a provider's own retry progress, and keeps a log detail out of it", () => {
    const retrying = (fact: Omit<AgentSessionFailureFact, 'kind'>) =>
      agentSessionFailureSentence({ kind: 'providerRetrying', ...fact }, 'row', {
        agentName: 'Codex'
      })
    expect(retrying({ detail: { text: 'Reconnecting... 2/5', audience: 'person' } })).toBe(
      'Codex is retrying: Reconnecting... 2/5.'
    )
    expect(
      retrying({
        detail: { text: '{"type":"system","subtype":"api_retry"}', audience: 'log' },
        retry: { error: 'rate_limit', status: 429 }
      })
    ).toBe('Codex is rate-limited and retrying.\nLast error: HTTP 429 rate limit.')
    expect(retrying({})).toBe('Codex hit a temporary problem and is retrying.')
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
