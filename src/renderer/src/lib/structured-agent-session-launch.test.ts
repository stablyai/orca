// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type * as RecoveryModule from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
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
  callStructuredAgentSession: mocks.callStructuredAgentSession
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
  hasStructuredAgentSessionLaunchCancellationTombstone,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    agent: 'codex',
    target: { kind: 'local' },
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
    expect(readOutbox(intent.sessionId)).toEqual([])
    expect(launch.promptDeliveryResult).toBeUndefined()
    expect(
      mocks.callStructuredAgentSession.mock.calls.some((call) => call[1] === 'agentSession.send')
    ).toBe(false)
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
    expect(readOutbox(intent.sessionId)).toEqual([])
  })

  it('preserves the draft seed when the launch is definitively refused', async () => {
    const worktreeId = 'wt-draft-refused'
    const intent = launchIntent(worktreeId, 'refused-draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
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

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent)
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

    const claude = startStructuredAgentLaunch(worktreeId, 'claude')
    const codex = startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenNthCalledWith(1, worktreeId, 'claude')
    expect(mocks.createIntent).toHaveBeenNthCalledWith(2, worktreeId, 'codex')
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(mocks.launch).mock.calls.map(([intent]) => intent.params.agent)).toEqual([
      'claude',
      'codex'
    ])
    expect(claude.sessionId).not.toBe(codex.sessionId)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('names the refused agent in the launch failure toast', async () => {
    const worktreeId = 'wt-claude-toast'
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))

    startStructuredAgentLaunch(worktreeId, 'claude')
    await flushLaunchSettlement()

    expect(toast.error).toHaveBeenCalledWith('Could not open Claude chat', expect.anything())
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

    startStructuredAgentLaunch(worktreeId, 'codex')
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

    startStructuredAgentLaunch(worktreeId, 'codex')
    startStructuredAgentLaunch(worktreeId, 'codex')

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('delivers a prompt from a coalesced caller after the shared launch settles', async () => {
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

    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    startStructuredAgentLaunch(worktreeId, 'codex')
    const second = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'second prompt' })

    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await expect(second.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    await flushLaunchSettlement()

    expect(mocks.callStructuredAgentSession).toHaveBeenCalledWith(
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
    let resolveDelivery!: (result: {
      ok: true
      value: { submission: { dispatchState: 'accepted' } }
    }) => void
    mocks.createIntent.mockReturnValue(intent)
    mocks.launch.mockImplementationOnce(() => new Promise((resolve) => (resolveLaunch = resolve)))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    mocks.callStructuredAgentSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDelivery = resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex')
    const coalesced = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'second prompt' })
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await vi.waitFor(() => expect(mocks.callStructuredAgentSession).toHaveBeenCalledOnce())

    startStructuredAgentLaunch(worktreeId, 'codex')
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()

    resolveDelivery({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    await expect(coalesced.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
  })

  it('keeps one launch identity per worktree while the outcome is unknown', async () => {
    const worktreeId = 'wt-unknown-different-prompts'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'first prompt' })
    await flushLaunchSettlement()
    startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'second prompt' })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  it('reconciles a host commit when the create reply is lost', async () => {
    const worktreeId = 'wt-response-loss'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new Error('response lost'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps the raw error out of the failure toast', async () => {
    const worktreeId = 'wt-no-raw-error-in-toast'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(
      new Error("EEXIST: file already exists, mkdir '/tmp/o97b/agent-sessions'")
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(toast.error).toHaveBeenCalledOnce()
    const description = String(vi.mocked(toast.error).mock.calls[0]?.[1]?.description ?? '')
    expect(description).not.toContain('EEXIST')
    expect(description).not.toContain('/tmp/')
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

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(intent)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps an unresolved identity reserved until inventory reconciles it', async () => {
    const worktreeId = 'wt-still-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()
    expect(toast.error).toHaveBeenCalledOnce()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('replays the same intent after an absent unknown outcome', async () => {
    const worktreeId = 'wt-replay-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, intent.sessionId)])

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reuses the queued prompt without a second delivery after unknown recovery', async () => {
    const worktreeId = 'wt-unknown-prompt-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'only once' })
    await expect(first.launchResult).rejects.toThrow('offline')
    expect(first.releaseCallerAfterUnknownOutcome()).toBe(true)

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    const retry = startStructuredAgentLaunch(worktreeId, 'codex')
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })

    expect(readOutbox(intent.sessionId)).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'only once' }] })
      })
    ])
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.anything()
    )
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

    const launch = startStructuredAgentLaunch(worktreeId, 'codex')

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

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()
    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.retryIntent).toHaveBeenCalledWith(first)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(first)
    expect(mocks.launch.mock.calls[1]?.[0]).toMatchObject({ sessionId: first.sessionId })
    expect(mocks.launch.mock.calls[1]?.[0].params.envelope.clientOperationId).not.toBe(
      first.params.envelope.clientOperationId
    )
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('does not stage the preserved launch prompt again on retry', async () => {
    const worktreeId = 'wt-refused-prompt-retry'
    const intent = launchIntent(worktreeId, 'session-refused-prompt-retry')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'only once',
      promptDelivery: 'draft'
    })
    await flushLaunchSettlement()
    expect(readOutbox(intent.sessionId)).toEqual([])

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'only once',
      promptDelivery: 'draft'
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })

    expect(readOutbox(intent.sessionId)).toEqual([])
    expect(mocks.seedDraft).toHaveBeenCalledOnce()
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
      resumeFrom: { providerSessionId: 'provider-session-1' }
    })
    await flushLaunchSettlement()

    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.retryIntent).toHaveBeenCalledWith(intent)
  })

  it('preserves the launch identity when durable prompt staging refuses', async () => {
    const worktreeId = 'wt-stage-refused'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    const storageFailure = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })

    const result = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'start this task' })

    await expect(result.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(result.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.abandonIntent).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBe('failed')
    storageFailure.mockRestore()
  })

  it('reports every coalesced prompt as undelivered after refusal', async () => {
    const worktreeId = 'wt-refused-coalesced-prompts'
    const intent = launchIntent(worktreeId)
    let rejectLaunch!: (error: unknown) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectLaunch = reject))
    )

    const first = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'first prompt' })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'second prompt' })
    expect(readOutbox(intent.sessionId)).toHaveLength(2)

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
    expect(readOutbox(intent.sessionId)).toHaveLength(2)
  })

  it('delivers a coalesced caller the way the launch it joined already decided', async () => {
    const worktreeId = 'wt-coalesced-delivery-mode'
    const intent = launchIntent(worktreeId, 'coalesced-delivery-session')
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'PR #1 context',
      promptDelivery: 'draft'
    })
    const joiner = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'PR #1 context',
      promptDelivery: 'auto-submit'
    })
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await flushLaunchSettlement()

    // Why: the first caller's seed is already in the composer, so submitting the joiner's copy
    // would show the user the text AND send it.
    expect(readOutbox(intent.sessionId)).toEqual([])
    expect(joiner.promptDeliveryResult).toBeUndefined()
    expect(
      mocks.callStructuredAgentSession.mock.calls.some((call) => call[1] === 'agentSession.send')
    ).toBe(false)
    expect(mocks.seedDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabId: 'structured-agent-session-coalesced-delivery-session',
        text: 'PR #1 context'
      })
    )
  })

  it('cancels a close-racing launch without retrying or toasting', async () => {
    const worktreeId = 'wt-close-race'
    const intent = launchIntent(worktreeId, 'session-close-race')
    let resolveRefresh!: (snapshots: RuntimeMobileSessionTabsResult[]) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex')
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledOnce())
    expect(cancelStructuredAgentLaunch(worktreeId, intent.sessionId)).toBe(true)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, intent.sessionId)).toBe(
      true
    )
    const persistedTombstones =
      localStorage.getItem('orca:structuredAgentLaunchCancelledSessions:v1') ?? ''
    expect(persistedTombstones).toContain(JSON.stringify(intent.sessionId))
    expect(persistedTombstones).not.toContain(worktreeId)
    resolveRefresh([])
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.abandonIntent).toHaveBeenCalledWith(intent)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('discards every coalesced prompt when a close cancels the launch', async () => {
    const worktreeId = 'wt-close-coalesced-prompts'
    const intent = launchIntent(worktreeId)
    let resolveRefresh!: (snapshots: RuntimeMobileSessionTabsResult[]) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'first prompt' })
    startStructuredAgentLaunch(worktreeId, 'codex', { prompt: 'second prompt' })
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledOnce())
    expect(readOutbox(intent.sessionId)).toHaveLength(2)

    expect(cancelStructuredAgentLaunch(worktreeId, intent.sessionId)).toBe(true)
    expect(readOutbox(intent.sessionId)).toEqual([])
    resolveRefresh([])
    await flushLaunchSettlement()
  })

  it('suppresses a close that races the retry verification catch', async () => {
    const worktreeId = 'wt-retry-close-race'
    const intent = launchIntent(worktreeId, 'session-retry-close-race')
    let resolveRetryRefresh!: (snapshots: RuntimeMobileSessionTabsResult[]) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('first response lost'))
      .mockRejectedValueOnce(new Error('retry response lost'))
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetryRefresh = resolve)))

    startStructuredAgentLaunch(worktreeId, 'codex')
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(2))
    expect(cancelStructuredAgentLaunch(worktreeId, intent.sessionId)).toBe(true)
    resolveRetryRefresh([])
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.abandonIntent).toHaveBeenCalledWith(intent)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
