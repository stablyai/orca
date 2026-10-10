// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  restoreIntent: vi.fn(),
  launch: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app; reads stay on this mock.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    method === 'agentSession.send'
      ? mocks.callRuntimeRpc(target, method, params)
      : mocks.callStructuredAgentSession(target, method, params)
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    }),
    subscribe: () => () => undefined
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { relaunchFailedStructuredAgentSessionWithMessage } from './structured-agent-session-launch-message'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

type Receipt = { sessionId: string; fence: number }

const WORKTREE_ID = 'wt-after-failure'

function launchIntent(sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    sessionId,
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(...sessionIds: string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-session' as const,
      id: `tab-${sessionId}`,
      title: 'Codex',
      sessionId,
      agent: 'codex' as const,
      isActive: false
    }))
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

const failed = launchIntent('session-failed')
const fresh = launchIntent('session-new')

async function refuseFirstLaunch(): Promise<void> {
  mocks.createIntent.mockReturnValueOnce(failed).mockReturnValueOnce(fresh)
  mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
  startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-1', prompt: 'first task' })
  await flushLaunchSettlement()
  expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBe('failed')
}

describe('a new launch after a failed one', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: { ...intent.params.envelope, clientOperationId: 'retried-operation' }
      }
    }))
    mocks.restoreIntent.mockImplementation((args: { sessionId: string }) =>
      launchIntent(args.sessionId)
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(failed.sessionId, fresh.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({ ok: true, page: { fence: 1 } })
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('opens a new chat that sends its own prompt instead of restarting the failed one', async () => {
    await refuseFirstLaunch()
    // Why: the + menu and new-tab search disable an agent only while its launch reads pending.
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('idle')

    mocks.launch.mockResolvedValueOnce({ sessionId: fresh.sessionId, fence: 1 })
    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-2',
      prompt: 'review notes',
      promptDelivery: 'submit-after-ready'
    })

    expect(notes.sessionId).toBe(fresh.sessionId)
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('pending')
    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({ sessionId: fresh.sessionId }),
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'review notes' }] })
      })
    )
    // The failed chat keeps its own prompt, in its own composer.
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBe('failed')
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(failed.sessionId))).toBe(
      'first task'
    )
  })

  it('retries the failed chat beside an in-flight new launch without taking it over', async () => {
    await refuseFirstLaunch()
    let resolveFresh!: (receipt: Receipt) => void
    let rejectRetry!: (error: unknown) => void
    mocks.launch
      .mockImplementationOnce(() => new Promise<Receipt>((resolve) => (resolveFresh = resolve)))
      .mockImplementationOnce(
        () => new Promise<Receipt>((_resolve, reject) => (rejectRetry = reject))
      )
    const next = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' })

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, failed.sessionId)).toBe(true)
    expect(mocks.launch.mock.calls[2]?.[0]).toMatchObject({ sessionId: failed.sessionId })
    // A re-delivery of the new pick joins the new launch, not the retried chat.
    expect(
      startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' }).sessionId
    ).toBe(fresh.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)

    // Closing the retried chat leaves the new launch registered and starting.
    rejectRetry(new StructuredAgentSessionCreateRefusalError('unsupported'))
    await flushLaunchSettlement()
    expect(cancelStructuredAgentLaunch(WORKTREE_ID, failed.sessionId)).toBe(true)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, fresh.sessionId)).toBe('pending')
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('pending')

    resolveFresh({ sessionId: fresh.sessionId, fence: 1 })
    await expect(next.launchResult).resolves.toEqual({ sessionId: fresh.sessionId, fence: 1 })
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('idle')
  })

  it('restores a failed chat after reload without unregistering a newer launch', async () => {
    await refuseFirstLaunch()
    // Reload: the registry is memory; the failed record is what survives.
    resetStructuredAgentLaunchRegistryForTests()
    let resolveFresh!: (receipt: Receipt) => void
    mocks.launch
      .mockImplementationOnce(() => new Promise<Receipt>((resolve) => (resolveFresh = resolve)))
      .mockResolvedValueOnce({ sessionId: failed.sessionId, fence: 1 })
    const next = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-5' })

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, failed.sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBeNull()
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, fresh.sessionId)).toBe('pending')
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('pending')
    resolveFresh({ sessionId: fresh.sessionId, fence: 1 })
    await expect(next.launchResult).resolves.toEqual({ sessionId: fresh.sessionId, fence: 1 })
  })

  it('reads a failed resume as not starting, so resuming again opens a new chat', async () => {
    const resumeFrom = { providerSessionId: 'provider-1' }
    mocks.createIntent.mockReturnValueOnce(failed).mockReturnValueOnce(fresh)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: fresh.sessionId, fence: 1 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-6', resumeFrom })
    await flushLaunchSettlement()
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('idle')

    expect(
      startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-7', resumeFrom })
        .sessionId
    ).toBe(fresh.sessionId)
  })
})

// A message sent into a chat whose start failed rides the restart, held until the chat exists.
describe('a message sent to a chat whose start failed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => intent)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(failed.sessionId)
    ])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  async function failThenTakeComposerText(): Promise<void> {
    await refuseFirstLaunch()
    // The failed start's own prompt waits in the composer; the person sends from there.
    clearNativeChatDraftCacheForTests()
  }

  it('restarts the chat and delivers the message once it publishes, never before', async () => {
    await failThenTakeComposerText()
    let publish = (_receipt: Receipt): void => {}
    mocks.launch.mockReturnValueOnce(new Promise<Receipt>((resolve) => (publish = resolve)))

    const delivery = relaunchFailedStructuredAgentSessionWithMessage(
      WORKTREE_ID,
      failed.sessionId,
      'restart and say hi'
    )
    expect(delivery).not.toBeNull()
    expect(mocks.retryIntent).toHaveBeenCalledOnce()
    // Held in the chat's one send slot, drawn as sending; nothing typed meanwhile goes first.
    expect(getStructuredAgentSessionPendingSends(failed.sessionId).map((e) => e.phase)).toEqual([
      'sending'
    ])
    expect(
      sendStructuredAgentSessionMessage({
        sessionId: failed.sessionId,
        target: { kind: 'local' },
        text: 'typed meanwhile'
      })
    ).toBeNull()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    publish({ sessionId: failed.sessionId, fence: 1 })
    await expect(delivery).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'restart and say hi' }] })
      })
    )
  })

  it('puts the message back in the composer when the restart fails again', async () => {
    await failThenTakeComposerText()
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))

    const delivery = relaunchFailedStructuredAgentSessionWithMessage(
      WORKTREE_ID,
      failed.sessionId,
      'still there?'
    )
    await expect(delivery).resolves.toEqual({ delivered: false, failureNotified: true })
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBe('failed')
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(failed.sessionId))).toBe(
      'still there?'
    )
    expect(getStructuredAgentSessionPendingSends(failed.sessionId)).toEqual([])
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does nothing for a chat whose start has not failed', () => {
    expect(
      relaunchFailedStructuredAgentSessionWithMessage(WORKTREE_ID, 'session-unknown', 'hi')
    ).toBeNull()
  })
})
