// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type * as RecoveryModule from '@/lib/structured-agent-session-launch-recovery'
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
  clearDraft: vi.fn(),
  rendererTabs: {} as Record<string, unknown[]>,
  listeners: new Set<(state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void>()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

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

vi.mock('@/lib/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
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
      unifiedTabsByWorktree: mocks.rendererTabs,
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    }),
    subscribe: (
      listener: (state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void
    ) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude'),
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { launchAndReconcile } from '@/lib/structured-agent-session-launch-recovery'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { hasStagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import { getStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    executionHostId: 'local',
    target: { kind: 'local' },
    sessionId,
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function sends(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'agentSession.send')
}

function composerDraft(sessionId: string): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredAgentLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.rendererTabs = {}
    mocks.listeners.clear()
    mocks.createIntent.mockImplementation((worktreeId: string, agent: 'claude' | 'codex') => {
      const intent = launchIntent(worktreeId, `${agent}-session-${worktreeId}`)
      return { ...intent, agent, params: { ...intent.params, agent } }
    })
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: {
          ...intent.params.envelope,
          clientOperationId: `${intent.params.envelope.clientOperationId}-retry`
        }
      }
    }))
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 }
    })
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('keeps launch drafts in the composer without staging or sending a turn', async () => {
    const worktreeId = 'wt-draft'
    const intent = launchIntent(worktreeId, 'draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-1',
      prompt: 'PR #19423 — review this change',
      promptDelivery: 'draft'
    })
    await launch.launchResult

    expect(mocks.seedDraft).toHaveBeenCalledWith({
      tabId: 'structured-agent-session-draft-session',
      agent: 'codex',
      text: 'PR #19423 — review this change',
      createdAt: expect.any(Number)
    })
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(false)
    expect(launch.promptDeliveryResult).toBeUndefined()
    expect(sends()).toHaveLength(0)
  })

  it('seeds a draft longer than the terminal mirror cap under the projected tab id', async () => {
    const worktreeId = 'wt-long-draft'
    const intent = launchIntent(worktreeId, 'long-draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    const sixtyLineDraft = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-2',
      prompt: sixtyLineDraft,
      promptDelivery: 'draft'
    })
    await launch.launchResult

    expect(mocks.seedDraft).toHaveBeenCalledWith({
      tabId: 'structured-agent-session-long-draft-session',
      agent: 'codex',
      text: sixtyLineDraft,
      createdAt: expect.any(Number)
    })
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(false)
  })

  it('preserves the draft seed when the launch is definitively refused', async () => {
    const worktreeId = 'wt-draft-refused'
    const intent = launchIntent(worktreeId, 'refused-draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-3',
      prompt: 'review this',
      promptDelivery: 'draft'
    })
    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await flushLaunchSettlement()

    expect(mocks.seedDraft).toHaveBeenCalledOnce()
    expect(mocks.clearDraft).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBe('failed')
  })

  it('preserves the draft seed when the launch fails with a known outcome', async () => {
    const worktreeId = 'wt-draft-failed'
    const intent = launchIntent(worktreeId, 'failed-draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    // Why: every real non-refusal error ends as visibility-unknown, which keeps the seed for the
    // retry; a known failure is the recovery layer rejecting with the outcome settled.
    vi.mocked(launchAndReconcile).mockRejectedValueOnce(new Error('boom'))

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-4',
      prompt: 'review this',
      promptDelivery: 'draft'
    })
    await expect(launch.launchResult).rejects.toThrow()
    await flushLaunchSettlement()

    expect(mocks.seedDraft).toHaveBeenCalledOnce()
    expect(mocks.clearDraft).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBe('failed')
  })

  it('clears the draft seed when the launch is cancelled', async () => {
    const worktreeId = 'wt-draft-cancelled'
    const intent = launchIntent(worktreeId, 'cancelled-draft-session')
    let resolveRefresh!: (snapshots: RuntimeMobileSessionTabsResult[]) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-5',
      prompt: 'review this',
      promptDelivery: 'draft'
    })
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledOnce())
    expect(cancelStructuredAgentLaunch(worktreeId, intent.sessionId)).toBe(true)
    resolveRefresh([])
    await flushLaunchSettlement()

    expect(mocks.clearDraft).toHaveBeenCalledWith(
      'structured-agent-session-cancelled-draft-session'
    )
  })

  it('opens the chat without an informational progress toast', async () => {
    const worktreeId = 'wt-open-quiet'
    const intent = launchIntent(worktreeId, 'session-1')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-6' })
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent, expect.any(Function))
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps a Claude and a Codex launch in the same worktree apart', async () => {
    const worktreeId = 'wt-two-agents'
    mocks.launch.mockImplementation(async (intent: StructuredAgentSessionLaunchIntent) => ({
      sessionId: intent.sessionId,
      fence: 1
    }))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, `claude-session-${worktreeId}`),
      publishedSnapshot(worktreeId, `codex-session-${worktreeId}`)
    ])

    const claude = startStructuredAgentLaunch(worktreeId, 'claude', { requestId: 'request-7' })
    const codex = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-8' })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      1,
      worktreeId,
      'claude',
      undefined,
      undefined,
      undefined
    )
    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      2,
      worktreeId,
      'codex',
      undefined,
      undefined,
      undefined
    )
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(mocks.launch).mock.calls.map(([intent]) => intent.params.agent)).toEqual([
      'claude',
      'codex'
    ])
    expect(claude.sessionId).not.toBe(codex.sessionId)
    expect(toast.error).not.toHaveBeenCalled()
  })

  // The chat's Retry line says a failed start; a toast beside it said it twice, again per Retry.
  it('leaves a failed start and each failed Retry to the chat, with no toast', async () => {
    const worktreeId = 'wt-claude-refused'
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))

    const { sessionId } = startStructuredAgentLaunch(worktreeId, 'claude', {
      requestId: 'request-9'
    })
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)).toBe('failed')

    expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)).toBe('failed')
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.message).not.toHaveBeenCalled()
  })

  it('requires authoritative inventory even when a matching local tab exists', async () => {
    const worktreeId = 'wt-host-frame'
    const intent = launchIntent(worktreeId, 'session-host-frame')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementationOnce(async () => {
      mocks.rendererTabs[worktreeId] = [
        { contentType: 'agent-session', entityId: intent.sessionId, worktreeId }
      ]
      for (const listener of mocks.listeners) {
        listener({ unifiedTabsByWorktree: mocks.rendererTabs })
      }
      return { sessionId: intent.sessionId, fence: 1 }
    })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-10' })
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledWith(undefined, {
      authoritative: true
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('coalesces a duplicate click silently while the launch is in flight', async () => {
    const worktreeId = 'wt-duplicate-click'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (receipt: { sessionId: string; fence: number }) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'double-click' })
    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'double-click' })

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("delivers a repeated request's prompt once, to both callers, after the shared launch settles", async () => {
    const worktreeId = 'wt-coalesced-prompt'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (receipt: { sessionId: string; fence: number }) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })

    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    for (const caller of [first, second]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    await flushLaunchSettlement()

    expect(second.sessionId).toBe(first.sessionId)
    expect(sends()).toHaveLength(1)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        body: expect.objectContaining({
          blocks: [{ type: 'text', text: 'second prompt' }]
        })
      })
    )
  })

  it('keeps the launch reserved until every coalesced prompt delivery settles', async () => {
    const worktreeId = 'wt-coalesced-prompt-reservation'
    const intent = launchIntent(worktreeId)
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const pendingSends: ((result: unknown) => void)[] = []
    mocks.createIntent.mockReturnValue(intent)
    mocks.launch.mockImplementationOnce(() => new Promise((resolve) => (resolveLaunch = resolve)))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    // Every send waits, so a second send of the repeated text would show up below.
    mocks.callRuntimeRpc.mockImplementation(
      () => new Promise((resolve) => pendingSends.push(resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    const coalesced = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce())

    const whileSending = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()

    await flushLaunchSettlement()
    for (const resolve of pendingSends) {
      resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    }
    for (const caller of [coalesced, whileSending]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })

  it('opens a new chat for a new start while an earlier outcome is unknown', async () => {
    const worktreeId = 'wt-unknown-different-prompts'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-18',
      prompt: 'first prompt'
    })
    await flushLaunchSettlement()
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-19',
      prompt: 'second prompt'
    })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(second.sessionId).not.toBe(intent.sessionId)
    await expect(second.launchResult).rejects.toThrow('offline')
    // Each start's text waits in its own chat's composer.
    expect(composerDraft(second.sessionId)).toBe('second prompt')
    expect(composerDraft(intent.sessionId)).toBe('first prompt')
  })

  it('reconciles a host commit when the create reply is lost', async () => {
    const worktreeId = 'wt-response-loss'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new Error('response lost'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-20' })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('logs the raw error of an unconfirmed start and leaves the telling to the chat', async () => {
    const worktreeId = 'wt-raw-error-logged'
    const intent = launchIntent(worktreeId)
    const raw = new Error("EEXIST: file already exists, mkdir '/tmp/o97b/agent-sessions'")
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(raw)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-21' })
      await flushLaunchSettlement()

      expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBe(
        'visibility-unknown'
      )
      expect(warn).toHaveBeenCalledWith('[native-chat] structured launch failed', raw)
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('retries an absent unknown outcome with the exact same intent', async () => {
    const worktreeId = 'wt-same-envelope-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, intent.sessionId)])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-22' })
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(intent)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  // Why a resume: the host refuses a second adoption of the conversation, so a new resume re-checks.
  it('keeps an unresolved resume identity reserved until inventory reconciles it', async () => {
    const worktreeId = 'wt-still-unknown'
    const resumeFrom = { providerSessionId: 'provider-still-unknown' }
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce({ ...intent, params: { ...intent.params, resumeFrom } })
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-23', resumeFrom })
    await flushLaunchSettlement()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-24', resumeFrom })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("keeps the prompt in the chat's composer, unsent, through an unknown outcome's recovery", async () => {
    const worktreeId = 'wt-unknown-prompt-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-25',
      prompt: 'only once'
    })
    await expect(first.launchResult).rejects.toThrow('offline')
    expect(first.releaseCallerAfterUnknownOutcome()).toBe(true)

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    // The chat's own Retry re-checks it; a new start would open a new chat instead.
    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBeNull()

    expect(composerDraft(intent.sessionId)).toBe('only once')
    expect(sends()).toHaveLength(0)
  })

  it('keeps a post-attach unknown outcome reserved for reconciliation', async () => {
    const worktreeId = 'wt-post-attach-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(
      Object.assign(new Error('The chat may already exist.'), {
        code: 'agent_session_operation_unknown'
      })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-26' })

    await expect(launch.launchResult).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(launch.isVisibilityUnknown()).toBe(true)
    expect(launch.releaseCallerAfterUnknownOutcome()).toBe(true)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
  })

  it('retries a definitively refused launch with the same session and a new operation', async () => {
    const worktreeId = 'wt-refused'
    const first = launchIntent(worktreeId, 'session-first')
    mocks.createIntent.mockReturnValueOnce(first)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: first.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, first.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-27' })
    await flushLaunchSettlement()
    expect(retryStructuredAgentSessionLaunch(worktreeId, first.sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.retryIntent).toHaveBeenCalledWith(first)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(first)
    expect(mocks.launch.mock.calls[1]?.[0]).toMatchObject({ sessionId: first.sessionId })
    expect(mocks.launch.mock.calls[1]?.[0].params.envelope.clientOperationId).not.toBe(
      first.params.envelope.clientOperationId
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  // A paired server's create seeds from its settings at create time, which its probe reports.
  it("shows the seed a paired server's probe reports on a retry, not the first admission's", async () => {
    const worktreeId = 'wt-paired-retry-seed'
    const intent: StructuredAgentSessionLaunchIntent = {
      ...launchIntent(worktreeId, 'session-paired-retry-seed'),
      executionHostId: 'runtime:server-1',
      target: { kind: 'environment', environmentId: 'server-1' },
      seedOptions: { model: 'gpt-5.5' }
    }
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockImplementationOnce(
        (_intent: StructuredAgentSessionLaunchIntent, onHostSeed?: (seed: unknown) => void) => {
          onHostSeed?.({ model: 'gpt-5.6-luna' })
          return new Promise(() => undefined)
        }
      )

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-28' })
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchSelection(intent.sessionId)?.seed).toEqual({
      model: 'gpt-5.5'
    })

    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchSelection(intent.sessionId)?.seed).toEqual({
      model: 'gpt-5.6-luna'
    })
  })

  it('retries a resumed launch by session id without reconstructing its identity', async () => {
    const worktreeId = 'wt-resume-inline-retry'
    const intent = {
      ...launchIntent(worktreeId, 'session-resume-inline-retry'),
      params: {
        ...launchIntent(worktreeId, 'session-resume-inline-retry').params,
        resumeFrom: { providerSessionId: 'provider-session-1' }
      }
    }
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-29',
      resumeFrom: { providerSessionId: 'provider-session-1' }
    })
    await flushLaunchSettlement()

    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.retryIntent).toHaveBeenCalledWith(intent)
  })

  it("reports a repeated request's prompt as undelivered to both callers after refusal", async () => {
    const worktreeId = 'wt-refused-coalesced-prompts'
    const intent = launchIntent(worktreeId)
    let rejectLaunch!: (error: unknown) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectLaunch = reject))
    )

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'first prompt'
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'first prompt'
    })
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(true)

    rejectLaunch(new StructuredAgentSessionCreateRefusalError('unsupported'))
    await expect(first.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(first.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(second.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    // The one staged text goes back to the chat's composer once.
    expect(composerDraft(intent.sessionId)).toBe('first prompt')
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(false)
  })

  it('keeps a drafted chat out of a second action that sends the same text', async () => {
    const worktreeId = 'wt-coalesced-delivery-mode'
    const drafted = launchIntent(worktreeId, 'coalesced-delivery-session')
    const sent = launchIntent(worktreeId, 'sent-delivery-session')
    mocks.createIntent.mockReturnValueOnce(drafted).mockReturnValueOnce(sent)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, drafted.sessionId),
      publishedSnapshot(worktreeId, sent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'continue-click',
      prompt: 'PR #1 context',
      promptDelivery: 'draft'
    })
    const other = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'fix-click',
      prompt: 'PR #1 context',
      promptDelivery: 'auto-submit'
    })

    // Why: two actions are two chats, whatever their text; neither lands in the other's chat.
    expect(other.sessionId).toBe(sent.sessionId)
    await expect(other.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(hasStagedStructuredLaunchPrompt(drafted.sessionId)).toBe(false)
    expect(sends().map((call) => call[2])).toEqual([
      expect.objectContaining({ envelope: expect.objectContaining({ sessionId: sent.sessionId }) })
    ])
    expect(mocks.seedDraft).toHaveBeenCalledOnce()
    expect(mocks.seedDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'structured-agent-session-coalesced-delivery-session',
        text: 'PR #1 context'
      })
    )
  })
})
