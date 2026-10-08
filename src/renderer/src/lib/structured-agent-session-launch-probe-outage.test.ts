// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const calls = vi.hoisted(() => ({
  log: new Array<string>(),
  createSupportAnswers: new Array<'supported' | 'offline'>()
}))

function offline(): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: '1',
    ok: false,
    error: { code: 'runtime_unavailable', message: 'connection lost' }
  })
}

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) => {
    calls.log.push(method)
    if (method === 'agentSession.createSupport') {
      if (calls.createSupportAnswers.shift() === 'supported') {
        return { supported: true }
      }
      throw offline()
    }
    // The create was sent and its reply lost when the connection dropped: the host may hold it.
    throw offline()
  })
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: vi.fn(async () => {
    calls.log.push('inventory')
    throw new Error('host offline')
  })
}))

import {
  createStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateUnknownOutcomeError
} from '@/lib/launch-structured-agent-session'
import { launchAndReconcile } from '@/lib/structured-agent-session-launch-recovery'

function launchState(executionHostId: 'local' | 'runtime:server-1') {
  return {
    intent: createStructuredAgentSessionLaunchIntent('wt-1', 'claude', executionHostId),
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false
  }
}

beforeEach(() => {
  calls.log.splice(0)
  calls.createSupportAnswers.splice(0)
})

// An outage is not an answer: the chat stays as "Could not confirm" with Retry, and the launch
// keeps its prompt, instead of being forgotten as though the host had said no.
describe('a structured launch whose host stops answering', () => {
  it('stays unconfirmed when the reply to a sent create is lost and the retry cannot reach it', async () => {
    calls.createSupportAnswers.push('supported', 'offline')
    const state = launchState('runtime:server-1')

    const error = await launchAndReconcile(state).catch((caught: unknown) => caught)

    expect(calls.log).toContain('agentSession.create')
    expect(error).toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(state.visibilityUnknown).toBe(true)
  })

  it('stays unconfirmed when this machine briefly cannot answer the probe', async () => {
    calls.createSupportAnswers.push('offline', 'offline')
    const state = launchState('local')

    const error = await launchAndReconcile(state).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(state.visibilityUnknown).toBe(true)
  })
})
