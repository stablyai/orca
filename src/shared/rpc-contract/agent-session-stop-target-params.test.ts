import { expect, it } from 'vitest'
import { CancelParams } from './structured-agent-session-params'

const envelope = {
  sessionId: 'session-1',
  clientOperationId: `1800000000000-${'a'.repeat(32)}`,
  expectedRuntimeFence: 1,
  payloadFingerprint: 'a'.repeat(64)
}

it('keeps legacy Stop valid and accepts optional turn, submission, and task targets', () => {
  expect(CancelParams.safeParse({ envelope }).success).toBe(true)
  expect(
    CancelParams.safeParse({ envelope, stopTarget: { kind: 'turn', turnId: 'one' } }).success
  ).toBe(true)
  expect(
    CancelParams.safeParse({
      envelope,
      stopTarget: { kind: 'submission', clientMessageId: 'send-1' }
    }).success
  ).toBe(true)
  expect(
    CancelParams.safeParse({
      envelope,
      scope: 'background-tasks',
      turnId: 'background-tasks',
      stopTarget: {
        kind: 'background-tasks',
        tasks: [{ id: 'one', invocation: { invocationId: 'attempt', generation: 1 } }]
      }
    }).success
  ).toBe(true)
})

it('refuses contradictory or oversized target payloads before execution', () => {
  expect(
    CancelParams.safeParse({ envelope, turnId: 'two', stopTarget: { kind: 'turn', turnId: 'one' } })
      .success
  ).toBe(false)
  expect(
    CancelParams.safeParse({
      envelope,
      scope: 'background-tasks',
      turnId: 'one',
      stopTarget: { kind: 'turn', turnId: 'one' }
    }).success
  ).toBe(false)
  expect(
    CancelParams.safeParse({
      envelope,
      scope: 'background-tasks',
      turnId: 'background-tasks',
      stopTarget: {
        kind: 'background-tasks',
        tasks: Array.from({ length: 513 }, () => ({
          id: 'one',
          invocation: { invocationId: 'attempt', generation: 1 }
        }))
      }
    }).success
  ).toBe(false)
})
