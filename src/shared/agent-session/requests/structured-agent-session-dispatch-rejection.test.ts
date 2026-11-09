import { describe, expect, it } from 'vitest'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_QUEUE_FULL
} from './structured-agent-session-dispatch-rejection'

describe('classifyDispatchRejection', () => {
  it('classifies a blocked provider resume as a start failure', () => {
    expect(
      classifyDispatchRejection({
        reason: 'The provider cannot resume this conversation.',
        rejection: { kind: 'providerResumeUnavailable' }
      })
    ).toEqual({ category: 'startFailed', verdict: 'failure', kind: 'providerResumeUnavailable' })
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
