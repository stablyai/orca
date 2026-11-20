import { describe, expect, it } from 'vitest'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import { resumeToastView } from './native-chat-resume-toast-view'

function chat(sessionId: string): ResumeCandidate {
  return {
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'codex',
    trigger: 'update',
    latestPrompt: 'fix the build',
    recordedAt: 1
  }
}

describe('resume toast view', () => {
  it('leaves a failure the host will not retry out of Resume', () => {
    const unretryable: ResumeFailure = {
      ...chat('stuck'),
      failedAt: 1,
      outcome: 'refused',
      reason: 'agent_session_not_attached',
      retryable: false
    }

    const view = resumeToastView([chat('stopped')], [unretryable])

    expect(view.resumable).toEqual(['stopped'])
    expect(view.counts.needsYou).toBe(1)
  })
})
