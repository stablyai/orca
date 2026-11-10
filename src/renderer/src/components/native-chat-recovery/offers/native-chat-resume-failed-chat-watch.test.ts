// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../shared/agent-session/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import {
  _resetNativeChatRestartOffer,
  dismissNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  subscribeStatus: vi.fn(),
  unsubscribe: vi.fn()
}))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.rpc
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

const failure = {
  sessionId: 'a',
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'update',
  latestPrompt: 'Fix it',
  recordedAt: 1,
  failedAt: 2,
  outcome: 'refused',
  reason: 'agent_session_restart_work_superseded'
}

function summary(
  status: AgentSessionStatusSummary['status'],
  latestPrompt: string,
  updatedAt: number
): AgentSessionStatusSummary {
  return {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    status,
    latestPrompt,
    updatedAt
  }
}

function hostEmit(): (event: AgentSessionStatusEvent) => void {
  const call = mocks.subscribeStatus.mock.calls[0]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return call[1]
}

function offerReads(): number {
  return mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.restartResumable')
    .length
}

async function listFailure(later: { failed: unknown[] } = { failed: [] }): Promise<void> {
  mocks.rpc
    .mockResolvedValueOnce({ sessions: [], failed: [failure] })
    .mockResolvedValue({ sessions: [], ...later })
  await refreshNativeChatRestartOffer()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
  _resetNativeChatRestartOffer()
  resetStructuredAgentSessionStatusFeedsForTests()
})

afterEach(() => {
  _resetNativeChatRestartOffer()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})

it('never lets a re-read that was already in flight bring back a dismissed failure', async () => {
  await listFailure({ failed: [failure] })
  const stale = Promise.withResolvers<unknown>()
  mocks.rpc.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.restartResumable'
      ? stale.promise
      : Promise.resolve({ sessions: [], failed: [] })
  )
  hostEmit()({ type: 'status', session: summary('working', 'Carry on please', Date.now() + 1) })
  await vi.advanceTimersByTimeAsync(500)
  expect(offerReads()).toBe(2)

  await dismissNativeChatRestartOffer(['a'])
  expect(getNativeChatRestartOffer().failed).toEqual([])
  stale.resolve({ sessions: [], failed: [failure] })
  await vi.advanceTimersByTimeAsync(0)

  expect(getNativeChatRestartOffer().failed).toEqual([])
})
