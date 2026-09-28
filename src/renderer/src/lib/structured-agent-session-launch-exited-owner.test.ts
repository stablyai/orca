// @vitest-environment happy-dom
// The launch client against the create wire contract: a failed create whose provider is proven
// gone reads as failed (with its reason) and Retry starts it again; any other verdict stays unknown.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionOwnerVerdict,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn<
    (
      target: unknown,
      method: string,
      params: { envelope: AgentSessionMutationEnvelope }
    ) => Promise<unknown>
  >(),
  refresh: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mocks.refresh
}))
vi.mock('@/runtime/web-session-focus-intent', () => ({
  clearWebSessionFocusIntentIfMatches: vi.fn(),
  recordWebSessionFocusIntent: vi.fn(),
  resolveWebSessionVisibleTabId: vi.fn(() => null)
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ seedNativeChatLaunchDraft: vi.fn(), clearNativeChatLaunchDraft: vi.fn() })
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import {
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchFailureReason,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'

const WORKTREE = 'wt-1'
const EXIT_REASON = 'claude stream-json exited (code 1): stderr tail'

/** The verdict the host puts on the failed operation's replay; undefined models an older host. */
let replayVerdict: AgentSessionOwnerVerdict | undefined
/** A host that answers the proven exit on the first call, not only on replay. */
let refuseFirstCall = false
let failedOperation: string | null = null
let publishedSessionId: string | null = null
const createdOperations: string[] = []

/** Mirrors the host: the first attempt's RPC fails, its replay is a durable refusal, and only
 *  a new operation creates the session again. */
function hostCreate(envelope: AgentSessionMutationEnvelope): unknown {
  createdOperations.push(envelope.clientOperationId)
  failedOperation ??= envelope.clientOperationId
  if (envelope.clientOperationId !== failedOperation) {
    publishedSessionId = envelope.sessionId
    return { ok: true, replayed: false, value: { sessionId: envelope.sessionId, fence: 3 } }
  }
  if (createdOperations.length === 1 && !refuseFirstCall) {
    throw new Error(EXIT_REASON)
  }
  const refusal: AgentSessionWireRefusal = {
    code: 'agent_session_operation_invalid',
    message: EXIT_REASON,
    ...(replayVerdict ? { ownerVerdict: replayVerdict } : {})
  }
  return { ok: false, refusal }
}

async function settle(sessionId: string): Promise<void> {
  await vi.waitFor(
    () => expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).not.toBe('pending'),
    { timeout: 5_000 }
  )
}

function launch(): string {
  const started = startStructuredAgentLaunch(WORKTREE, 'codex')
  void started.launchResult.catch(() => undefined)
  return started.sessionId
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  replayVerdict = 'exited'
  refuseFirstCall = false
  failedOperation = null
  publishedSessionId = null
  createdOperations.length = 0
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.createSupport') {
      return { supported: true }
    }
    if (method === 'agentSession.create') {
      return hostCreate(params.envelope)
    }
    throw new Error(`unexpected ${method}`)
  })
  mocks.refresh.mockImplementation(async () =>
    publishedSessionId
      ? [{ worktree: WORKTREE, tabs: [{ type: 'agent-session', sessionId: publishedSessionId }] }]
      : []
  )
})

describe('structured launch after a host-failed create', () => {
  it('fails with the host reason when the provider is proven gone, and Retry starts it under a new operation', async () => {
    const sessionId = launch()
    await settle(sessionId)

    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).toBe('failed')
    expect(getStructuredAgentSessionLaunchFailureReason(WORKTREE, sessionId)).toBe(EXIT_REASON)
    expect(createdOperations.every((operation) => operation === failedOperation)).toBe(true)

    expect(retryStructuredAgentSessionLaunch(WORKTREE, sessionId)).toBe(true)
    await settle(sessionId)

    expect(createdOperations.at(-1)).not.toBe(failedOperation)
    expect(publishedSessionId).toBe(sessionId)
    // A published launch retires its client state; failed or unknown would linger.
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).toBeNull()
  })

  it('fails on the first answer when the host already refuses with the proven exit', async () => {
    refuseFirstCall = true
    const sessionId = launch()
    await settle(sessionId)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).toBe('failed')
    expect(getStructuredAgentSessionLaunchFailureReason(WORKTREE, sessionId)).toBe(EXIT_REASON)
    expect(createdOperations).toEqual([failedOperation])
    expect(retryStructuredAgentSessionLaunch(WORKTREE, sessionId)).toBe(true)
    await settle(sessionId)
    expect(createdOperations.at(-1)).not.toBe(failedOperation)
    expect(publishedSessionId).toBe(sessionId)
  })

  it.each([
    ['the host could not prove the process gone', 'unverifiable'],
    ['the host predates the verdict', undefined]
  ] as const)('stays unknown when %s', async (_label, verdict) => {
    replayVerdict = verdict
    const sessionId = launch()
    await settle(sessionId)

    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).toBe('visibility-unknown')
    expect(createdOperations.every((operation) => operation === failedOperation)).toBe(true)
  })
})
