// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  useStructuredAgentSessionStatusSummary,
  useStructuredAgentSessionHostExecution
} from './structured-agent-session-status-hooks'

const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'another-host' } as const
function summary(
  sessionId: string,
  patch: Partial<AgentSessionStatusSummary> = {}
): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: 'workspace',
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'go',
    updatedAt: 1,
    ...patch
  }
}
function emit(index: number, event: AgentSessionStatusEvent): void {
  const callback: (event: AgentSessionStatusEvent) => void = mocks.subscribe.mock.calls[index]![1]
  callback(event)
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  resetStructuredAgentSessionStatusFeedsForTests()
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})

it('publishes row-free retry retirement and Interrupted without rendering unrelated sessions or hosts', async () => {
  const renders = [0, 0, 0]
  const mount = (sessionId: string, target: typeof local | typeof remote, index: number) =>
    renderHook(() => {
      renders[index]++
      return {
        ...useStructuredAgentSessionStatusSummary(sessionId, target),
        ...useStructuredAgentSessionHostExecution(sessionId, target)
      }
    })
  const one = mount('one', local, 0)
  mount('two', local, 1)
  mount('one', remote, 2)
  await act(() => vi.advanceTimersByTimeAsync(0))
  await act(async () => emit(0, { type: 'snapshot', sessions: [summary('one'), summary('two')] }))
  await act(async () => emit(1, { type: 'snapshot', sessions: [summary('one')] }))
  const before = [...renders]
  await act(async () =>
    emit(0, {
      type: 'status',
      session: summary('one', { status: 'working', turnOutcome: 'failure' })
    })
  )
  expect(renders[0]).toBeGreaterThan(before[0]!)
  expect(renders.slice(1)).toEqual(before.slice(1))
  expect(one.result.current.summary?.status).toBe('working')
  const working = [...renders]
  // No journal row accompanies the final option-retirement/Stop status update.
  await act(async () =>
    emit(0, { type: 'status', session: summary('one', { turnOutcome: 'cancellation' }) })
  )
  expect(renders[0]).toBeGreaterThan(working[0]!)
  expect(renders.slice(1)).toEqual(working.slice(1))
  const status = one.result.current.summary!
  expect(
    agentVerdictDisplayMark(
      structuredAgentSessionAgentStatus({ ...status, status: status.status ?? 'idle' })
    )
  ).toBe('interrupted')
  const settled = [...renders]
  await act(async () => emit(1, { type: 'status', session: summary('one', { status: 'working' }) }))
  expect(renders.slice(0, 2)).toEqual(settled.slice(0, 2))
  expect(renders[2]).toBeGreaterThan(settled[2]!)
})
