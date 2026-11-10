import { describe, expect, it } from 'vitest'
import { resumeFailureGuidance } from './native-chat-resume-failure-guidance'

describe('resumeFailureGuidance', () => {
  // Provider refusals already live in the chat; respect the host’s non-retryable verdict.

  it('never offers a retry for a delivery nobody could confirm', () => {
    expect(
      resumeFailureGuidance({ outcome: 'unconfirmed', reason: 'agent_session_conflict' })
    ).toMatchObject({ primary: 'open', secondary: null })
  })
})
