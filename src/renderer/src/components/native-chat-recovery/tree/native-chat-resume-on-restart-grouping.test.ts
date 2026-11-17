import { describe, expect, it } from 'vitest'
import {
  launchResumeSessionIds,
  type ResumeCandidate
} from './native-chat-resume-on-restart-grouping'

function candidate(sessionId: string, activity?: ResumeCandidate['activity']): ResumeCandidate {
  return {
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'fix the build',
    recordedAt: 1,
    ...(activity ? { activity } : {})
  }
}

describe('launchResumeSessionIds', () => {
  it('resumes working chats and leaves chats waiting on the person offered', () => {
    expect(
      launchResumeSessionIds([
        candidate('working', { state: 'working', prompts: [], tasks: [] }),
        candidate('approval', {
          state: 'blocked',
          prompts: [{ kind: 'approval', label: 'Run a command?' }],
          tasks: [{ kind: 'agent', label: 'explorer' }]
        }),
        candidate('question', {
          state: 'blocked',
          prompts: [{ kind: 'question', label: 'Which branch?' }],
          tasks: []
        }),
        candidate('older-host')
      ])
    ).toEqual(['working', 'older-host'])
  })
})
