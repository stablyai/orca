import { describe, expect, it } from 'vitest'
import { resumeFailureGuidance } from './native-chat-resume-failure-guidance'

describe('resumeFailureGuidance', () => {
  // Provider refusals already live in the chat; respect the host’s non-retryable verdict.
  it.each(['codex said no', 'agent_session_conflict'])(
    'offers no retry for %s once the host says a retry would not run',
    (reason) => {
      expect(resumeFailureGuidance({ outcome: 'refused', reason, retryable: false })).toMatchObject(
        { primary: 'open', secondary: 'dismiss' }
      )
      expect(resumeFailureGuidance({ outcome: 'refused', reason, retryable: true })).toMatchObject(
        resumeFailureGuidance({ outcome: 'refused', reason })
      )
    }
  )

  it('never offers a retry for a delivery nobody could confirm', () => {
    expect(
      resumeFailureGuidance({ outcome: 'unconfirmed', reason: 'agent_session_conflict' })
    ).toMatchObject({ primary: 'open', secondary: null })
  })
})
