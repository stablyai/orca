import { describe, expect, it } from 'vitest'
import {
  classifyOrchestrationAskOutcome,
  withOrchestrationAskOutcome
} from './orchestration-ask-outcome'

describe('classifyOrchestrationAskOutcome', () => {
  it('classifies answered questions as not pending', () => {
    expect(
      classifyOrchestrationAskOutcome({
        answer: 'yes',
        timedOut: false
      })
    ).toEqual({ outcome: 'answered', pending: false })
  })

  it('classifies timeout as resumable pending (not an internal error)', () => {
    // Why: external engines historically mapped exit 1 + bare JSON to hard failure (#13184).
    expect(
      classifyOrchestrationAskOutcome({
        answer: null,
        timedOut: true
      })
    ).toEqual({ outcome: 'timed_out_pending', pending: true })
  })

  it('classifies connection-lost cancel as resumable pending', () => {
    expect(
      classifyOrchestrationAskOutcome({
        answer: null,
        timedOut: false,
        cancelled: true,
        connectionLost: true
      })
    ).toEqual({ outcome: 'connection_lost_pending', pending: true })
  })

  it('classifies Windows commit/resume split as resume_required', () => {
    expect(
      classifyOrchestrationAskOutcome({
        answer: null,
        timedOut: false,
        legacyCompatibility: { resumeRequired: true }
      })
    ).toEqual({ outcome: 'resume_required', pending: true })
  })

  it('spreads outcome fields onto the JSON payload', () => {
    const payload = withOrchestrationAskOutcome({
      answer: null,
      messageId: 'msg_q',
      threadId: 'thr_1',
      timedOut: true,
      timeoutMs: 60_000
    })
    expect(payload.outcome).toBe('timed_out_pending')
    expect(payload.pending).toBe(true)
    expect(payload.messageId).toBe('msg_q')
  })
})
