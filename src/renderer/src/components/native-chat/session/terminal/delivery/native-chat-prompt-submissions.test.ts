import { createHash } from 'node:crypto'
import { beforeEach, expect, it } from 'vitest'
import type { NativeChatPendingSend } from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  appendPendingSendCache,
  associatePendingPromptSubmissions,
  clearPendingSendCacheForTests,
  readPendingSendCache,
  writePendingSendCache
} from './native-chat-pending'

const scope = { paneKey: 'pane', agent: 'codex' }
const process = { pid: 42, platform: 'linux' as const, startTime: 'start' }
const baseline = {
  process,
  connectionId: 'connection',
  sessionId: 'session',
  observation: {
    origin: 'hook' as const,
    authorityId: 'host',
    incarnation: 1,
    revision: 10,
    observedAt: 1
  }
}
const textDigest = createHash('sha256').update('repeat').digest('hex')
const submission = (revision: number) => ({
  ...baseline,
  textDigest,
  observation: { ...baseline.observation, revision }
})
function send(id: string): NativeChatPendingSend {
  return {
    id,
    text: 'repeat',
    sourceAgent: 'codex',
    sentAt: 1,
    dispatchPending: true,
    promptBinding: {
      runtimeId: 'host',
      ptyId: 'pty',
      generation: 1,
      processIncarnation: 'pty:1',
      terminalHandle: 'terminal',
      targetPtyId: 'pty',
      runtimeEnvironmentId: null,
      rootBaseline: baseline
    }
  }
}
beforeEach(clearPendingSendCacheForTests)

it('assigns original hook occurrences once in send order and burns them through retirement and remount', () => {
  appendPendingSendCache(scope, send('first'))
  const entries = appendPendingSendCache(scope, send('second'))
  const history = [submission(11), submission(12)]
  const assigned = associatePendingPromptSubmissions(scope, entries, history)
  expect(assigned.map((entry) => [entry.id, entry.promptSubmission?.observation.revision])).toEqual(
    [
      ['first', 11],
      ['second', 12]
    ]
  )
  writePendingSendCache(scope, [])
  const later = appendPendingSendCache(scope, send('later'))
  writePendingSendCache(scope, associatePendingPromptSubmissions(scope, later, history))
  expect(readPendingSendCache(scope)[0].promptSubmission).toBeUndefined()
  expect(
    associatePendingPromptSubmissions(scope, readPendingSendCache(scope), [
      ...history,
      submission(13)
    ])[0].promptSubmission?.observation.revision
  ).toBe(13)
})

it('does not borrow observations from an older baseline, replacement root, connection or known session', () => {
  const entries = appendPendingSendCache(scope, send('first'))
  const foreign = [
    submission(10),
    { ...submission(11), process: { ...process, startTime: 'replacement' } },
    { ...submission(12), connectionId: 'other' },
    { ...submission(13), sessionId: 'other' }
  ]
  expect(
    associatePendingPromptSubmissions(scope, entries, foreign)[0].promptSubmission
  ).toBeUndefined()
  expect(
    associatePendingPromptSubmissions(scope, entries, [submission(14)])[0].promptSubmission
      ?.observation.revision
  ).toBe(14)
})
