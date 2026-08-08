import { expect, it } from 'vitest'
import { acceptCodexRolloutRecord, type CodexRolloutScope } from './codex-rollout-scope'

it('honors the inclusive absolute boundary without accepting inherited metadata or missing ordinals', () => {
  const scope: CodexRolloutScope = {}
  expect(
    acceptCodexRolloutRecord(scope, {
      type: 'session_meta',
      ordinal: 0,
      payload: { id: 'child', subagent_history_start_ordinal: 21 }
    })
  ).toBe(true)
  expect(
    acceptCodexRolloutRecord(scope, { type: 'session_meta', ordinal: 1, payload: { id: 'parent' } })
  ).toBe(false)
  expect(scope).toEqual({ sessionId: 'child', historyStartOrdinal: 21 })
  for (const ordinal of [20, undefined, Number.NaN, 21.5]) {
    expect(acceptCodexRolloutRecord(scope, { type: 'event_msg', ordinal })).toBe(false)
  }
  expect(acceptCodexRolloutRecord(scope, { type: 'event_msg', ordinal: 21 })).toBe(true)
  expect(acceptCodexRolloutRecord(scope, { type: 'event_msg', ordinal: 100 })).toBe(true)
})

it('preserves legacy/canonicalized history when there is no explicit boundary', () => {
  const scope: CodexRolloutScope = {}
  acceptCodexRolloutRecord(scope, { type: 'session_meta', payload: { id: 'child' } })
  expect(acceptCodexRolloutRecord(scope, { type: 'event_msg' })).toBe(true)
  expect(acceptCodexRolloutRecord(scope, { type: 'session_meta', payload: { id: 'parent' } })).toBe(
    false
  )
  expect(scope.sessionId).toBe('child')
})
