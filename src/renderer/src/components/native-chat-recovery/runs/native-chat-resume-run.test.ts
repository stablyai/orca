import { expect, it } from 'vitest'
import {
  beginResumeRun,
  isResumeRunSessionStarting,
  nextResumeRun,
  observeResumeRun,
  settledResumeRun,
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

it('sends nothing while an action is in flight, even a different chat', () => {
  const first = nextResumeRun(null, [candidate('failed')], 3, 'user')

  expect(unsentResumeIds(null, ['failed', 'failed'])).toEqual(['failed'])
  expect(unsentResumeIds(first, ['failed'])).toEqual([])
  expect(unsentResumeIds(first, ['other'])).toEqual([])
  expect(unsentResumeIds({ ...first, inFlight: false }, ['failed'])).toEqual(['failed'])
})

it('keeps chats an earlier run resumed in the report when a retry replaces the run', () => {
  const settled = settledResumeRun(
    beginResumeRun([candidate('a'), candidate('b'), candidate('failed')], 1, 'launch'),
    new Set(['a', 'b', 'failed']),
    new Set(),
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'continued' },
      { sessionId: 'failed', outcome: 'refused' }
    ]
  )
  const retry = nextResumeRun(settled, [candidate('failed')], 2, 'user')
  expect(retry.entries.map((entry) => entry.candidate.sessionId)).toEqual(['failed'])
  expect(retry.resumedBefore?.map((row) => row.sessionId)).toEqual(['a', 'b'])

  const done = settledResumeRun(retry, new Set(['failed']), new Set(), [
    { sessionId: 'failed', outcome: 'continued' }
  ])
  expect(done.resumedBefore).toBeUndefined()
  expect(done.entries.map((entry) => entry.candidate.sessionId)).toEqual(['a', 'b', 'failed'])
  expect(done.continued?.every((entry) => entry.outcome === 'continued')).toBe(true)

  // A retry the host skips still leaves the earlier successes as a settled run.
  const skipped = settledResumeRun(retry, new Set(), new Set(['failed']), [])
  expect(skipped.entries.map((entry) => entry.candidate.sessionId)).toEqual(['a', 'b'])
})
