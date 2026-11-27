import { expect, it } from 'vitest'
import {
  beginResumeRun,
  isResumeRunSessionStarting,
  nextResumeRun,
  observeResumeRun,
  unsentResumeIds
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

const candidate = (sessionId: string): ResumeCandidate => ({
  sessionId,
  workspaceId: 'example-workspace',
  agent: 'claude',
  trigger: 'update',
  latestPrompt: 'Example prompt',
  recordedAt: 1
})

it('sends a chat once when Retry is activated twice before the first action settles', () => {
  const first = nextResumeRun(null, [candidate('failed')], 3, 'user')

  expect(unsentResumeIds(null, ['failed', 'failed'])).toEqual(['failed'])
  expect(unsentResumeIds(first, ['failed'])).toEqual([])
  expect(unsentResumeIds({ ...first, inFlight: false }, ['failed'])).toEqual(['failed'])
})

it('keeps chats an earlier run resumed in the report when a retry replaces the run', () => {
  const settled = {
    ...beginResumeRun([candidate('a'), candidate('b'), candidate('failed')], 1, 'launch'),
    inFlight: false,
    continued: [
      { sessionId: 'a', outcome: 'continued' as const },
      { sessionId: 'b', outcome: 'continued' as const },
      { sessionId: 'failed', outcome: 'refused' as const }
    ]
  }
  const retry = nextResumeRun(settled, [candidate('failed')], 2, 'user')
  expect(retry.entries.map((entry) => entry.candidate.sessionId)).toEqual(['failed'])
  expect(retry.resumedBefore?.map((row) => row.sessionId)).toEqual(['a', 'b'])

  const again = nextResumeRun(
    { ...retry, inFlight: false, continued: [{ sessionId: 'failed', outcome: 'refused' }] },
    [candidate('failed'), candidate('a')],
    3,
    'user'
  )
  expect(again.resumedBefore?.map((row) => row.sessionId)).toEqual(['b'])
})
