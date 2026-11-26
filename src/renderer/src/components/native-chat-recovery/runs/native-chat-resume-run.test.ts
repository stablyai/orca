import { expect, it } from 'vitest'
import {
  beginResumeRun,
  isResumeRunSessionStarting,
  observeResumeRun
} from './native-chat-resume-run'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'

it('detects only chats still pending in the active resume run', () => {
  const chat: ResumeCandidate = {
    sessionId: 'chat-a',
    workspaceId: 'example-workspace',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'Example prompt',
    recordedAt: 1
  }
  const run = beginResumeRun(
    [
      chat,
      { ...chat, sessionId: 'chat-b' },
      { ...chat, sessionId: 'terminal-c', surface: 'terminal' }
    ],
    2,
    'launch'
  )
  const observed = observeResumeRun(run, (id) =>
    id === 'chat-b' ? { restartResume: { phase: 'continued' } } : undefined
  )

  expect(isResumeRunSessionStarting(observed, 'chat-a')).toBe(true)
  expect(isResumeRunSessionStarting(observed, 'chat-b')).toBe(false)
  expect(isResumeRunSessionStarting(observed, 'terminal-c')).toBe(false)
  expect(isResumeRunSessionStarting(observed, 'unrelated')).toBe(false)
  expect(isResumeRunSessionStarting({ ...observed, inFlight: false }, 'chat-a')).toBe(false)
})
