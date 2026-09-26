// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  _resetNativeChatRestartOffer,
  continueNativeChatRestartOffer,
  dismissNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  subscribeStatus: vi.fn(),
  unsubscribe: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.rpc,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

// When the user sends in an offered or failed chat, its status bar entry must retire without the
// user reopening anything, and nothing may run while nothing is offered or failed.

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

/** Lists one failed chat, then answers every later read with `later`. */
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

// The host withdraws a pending offer once the chat moves on; the status bar must not keep counting it.
it('re-reads once when the user sends in an offered chat, and the count drops', async () => {
  const { failedAt: _failedAt, outcome: _outcome, reason: _reason, ...candidate } = failure
  mocks.rpc
    .mockResolvedValueOnce({ sessions: [candidate], failed: [] })
    .mockResolvedValue({ sessions: [], failed: [] })
  await refreshNativeChatRestartOffer()
  await vi.advanceTimersByTimeAsync(0)
  expect(getNativeChatRestartOffer().candidates).toHaveLength(1)
  expect(mocks.subscribeStatus).toHaveBeenCalledOnce()

  hostEmit()({ type: 'status', session: summary('working', 'Something else', Date.now() + 10_000) })
  await vi.advanceTimersByTimeAsync(500)

  expect(offerReads()).toBe(2)
  expect(getNativeChatRestartOffer().candidates).toEqual([])
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('opens no status stream while nothing is offered or failed', async () => {
  mocks.rpc.mockResolvedValue({ sessions: [], failed: [] })
  await refreshNativeChatRestartOffer()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.subscribeStatus).not.toHaveBeenCalled()
})

it('re-reads once when the user replies in a failed chat, then lets the stream go', async () => {
  await listFailure()
  expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
  const later = Date.now() + 10_000
  hostEmit()({ type: 'status', session: summary('working', 'Carry on please', later) })
  hostEmit()({ type: 'status', session: summary('idle', 'Carry on please', later + 1) })
  expect(offerReads()).toBe(1)

  await vi.advanceTimersByTimeAsync(500)

  expect(offerReads()).toBe(2)
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('does not re-read for an agent streaming in a failed chat or for news older than the list', async () => {
  await listFailure({ failed: [failure] })
  const later = Date.now() + 10_000
  // Already reflected in the listing the store holds.
  hostEmit()({ type: 'snapshot', sessions: [summary('working', 'Replayed note', 1)] })
  hostEmit()({ type: 'status', session: summary('working', 'Replayed note', later) })
  await vi.advanceTimersByTimeAsync(500)
  expect(offerReads()).toBe(1)

  hostEmit()({ type: 'status', session: summary('idle', 'Replayed note', later + 1) })
  await vi.advanceTimersByTimeAsync(500)
  // Still failed, so the watch stays for the user's own reply.
  expect(offerReads()).toBe(2)
  expect(mocks.unsubscribe).not.toHaveBeenCalled()
})

// Host and renderer stamp time separately, and the host can answer a list just before a reply is
// delivered here: a change to a chat already seen is news whatever its timestamp says.
it('re-reads for a known failed chat that changes even when its stamp predates the list', async () => {
  await listFailure()
  hostEmit()({ type: 'snapshot', sessions: [summary('idle', 'Fix it', 1)] })
  hostEmit()({ type: 'status', session: summary('working', 'Carry on please', 2) })
  await vi.advanceTimersByTimeAsync(500)
  expect(offerReads()).toBe(2)
  expect(getNativeChatRestartOffer().failed).toEqual([])
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

// A retry changes the chat it acts on; its own answer follows, so a read mid-action would only
// flash a half-finished list.
it('waits for a resume in flight instead of re-reading under it', async () => {
  await listFailure({ failed: [failure] })
  const acting = Promise.withResolvers<unknown>()
  mocks.rpc.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.restartContinue'
      ? acting.promise
      : Promise.resolve({ sessions: [], failed: [failure] })
  )
  const retry = continueNativeChatRestartOffer(['a'])
  hostEmit()({ type: 'status', session: summary('working', 'Carry on please', Date.now() + 1) })
  await vi.advanceTimersByTimeAsync(500)
  expect(offerReads()).toBe(1)

  acting.resolve({
    sessions: [],
    failed: [],
    continued: [{ sessionId: 'a', outcome: 'continued' }]
  })
  await retry
  expect(getNativeChatRestartOffer().failed).toEqual([])
})
