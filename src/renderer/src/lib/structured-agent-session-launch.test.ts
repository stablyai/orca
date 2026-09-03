// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  createIntent: vi.fn(),
  launch: vi.fn(),
  rendererTabs: {} as Record<string, unknown[]>,
  listeners: new Set<(state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void>()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-codex-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredCodexSessionLaunchIntent: mocks.createIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredCodexSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ unifiedTabsByWorktree: mocks.rendererTabs }),
    subscribe: (
      listener: (state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void
    ) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  cancelStructuredCodexLaunch,
  startStructuredCodexLaunch
} from './structured-agent-session-launch'
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
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

describe('startStructuredCodexLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.rendererTabs = {}
    mocks.listeners.clear()
    mocks.createIntent.mockImplementation((worktreeId: string) => launchIntent(worktreeId))
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 }
    })
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

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('completes from the host-emitted projection without listing inventory', async () => {
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

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
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

    startStructuredCodexLaunch(worktreeId)
    startStructuredCodexLaunch(worktreeId)

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
    startStructuredCodexLaunch(worktreeId)
    const second = startStructuredCodexLaunch(worktreeId, { prompt: 'second prompt' })

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

    startStructuredCodexLaunch(worktreeId)
    const coalesced = startStructuredCodexLaunch(worktreeId, { prompt: 'second prompt' })
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await vi.waitFor(() => expect(mocks.callStructuredAgentSession).toHaveBeenCalledOnce())

    startStructuredCodexLaunch(worktreeId)
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

    startStructuredCodexLaunch(worktreeId, { prompt: 'first prompt' })
    await flushLaunchSettlement()
    startStructuredCodexLaunch(worktreeId, { prompt: 'second prompt' })
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

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
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

    startStructuredCodexLaunch(worktreeId)
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

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    expect(toast.error).toHaveBeenCalledOnce()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('replays the same intent after an absent unknown outcome', async () => {
    const worktreeId = 'wt-replay-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => {
      mocks.rendererTabs[worktreeId] = [
        { contentType: 'agent-session', entityId: intent.sessionId, worktreeId }
      ]
      for (const listener of mocks.listeners) {
        listener({ unifiedTabsByWorktree: mocks.rendererTabs })
      }
      return { sessionId: intent.sessionId, fence: 1 }
    })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValueOnce([]).mockResolvedValueOnce([])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reuses the queued prompt without a second delivery after unknown recovery', async () => {
    const worktreeId = 'wt-unknown-prompt-retry'
    const intent = launchIntent(worktreeId)
    const firstFallback = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredCodexLaunch(worktreeId, { prompt: 'only once' })
    const firstFallbackResult = first.claimDefinitiveRefusalFallback(firstFallback)
    await expect(first.launchResult).rejects.toThrow('offline')
    expect(first.releaseCallerAfterUnknownOutcome()).toBe(true)

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    const retry = startStructuredCodexLaunch(worktreeId)
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })

    await expect(firstFallbackResult).resolves.toBe(false)
    expect(firstFallback).not.toHaveBeenCalled()
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

  it('runs only the retry fallback when unknown recovery is refused', async () => {
    const worktreeId = 'wt-unknown-refusal-retry'
    const intent = launchIntent(worktreeId)
    const firstFallback = vi.fn()
    const retryFallback = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredCodexLaunch(worktreeId)
    const firstFallbackResult = first.claimDefinitiveRefusalFallback(firstFallback)
    await expect(first.launchResult).rejects.toThrow('offline')
    expect(first.releaseCallerAfterUnknownOutcome()).toBe(true)

    mocks.launch.mockRejectedValueOnce(
      new StructuredAgentSessionCreateRefusalError('structured launch disabled')
    )
    const retry = startStructuredCodexLaunch(worktreeId)
    const retryFallbackResult = retry.claimDefinitiveRefusalFallback(retryFallback)

    await expect(retry.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(firstFallbackResult).resolves.toBe(false)
    await expect(retryFallbackResult).resolves.toBe(true)
    expect(firstFallback).not.toHaveBeenCalled()
    expect(retryFallback).toHaveBeenCalledOnce()
  })

  it('releases a definitively refused intent so a new click can create a new identity', async () => {
    const worktreeId = 'wt-refused'
    const first = launchIntent(worktreeId, 'session-first')
    const second = launchIntent(worktreeId, 'session-second')
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: second.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, second.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(first)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(second)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('abandons the focus intent when durable prompt staging refuses the launch', async () => {
    const worktreeId = 'wt-stage-refused'
    const intent = launchIntent(worktreeId)
    const fallback = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    const storageFailure = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })

    const result = startStructuredCodexLaunch(worktreeId, { prompt: 'start this task' })
    const fallbackResult = result.claimDefinitiveRefusalFallback(fallback)

    await expect(result.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(fallbackResult).resolves.toBe(true)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.abandonIntent).toHaveBeenCalledWith(intent)
    storageFailure.mockRestore()
  })

  it('runs each caller fallback and preserves its delivery result after refusal', async () => {
    const worktreeId = 'wt-refused-coalesced-prompts'
    const intent = launchIntent(worktreeId)
    let rejectLaunch!: (error: unknown) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectLaunch = reject))
    )

    const first = startStructuredCodexLaunch(worktreeId, { prompt: 'first prompt' })
    const second = startStructuredCodexLaunch(worktreeId, { prompt: 'second prompt' })
    const firstFallback = vi.fn().mockResolvedValue({
      delivered: true,
      failureNotified: false
    })
    const secondFallback = vi.fn().mockResolvedValue({
      delivered: false,
      failureNotified: true
    })
    const firstFallbackResult = first.claimDefinitiveRefusalFallback(firstFallback)
    const secondFallbackResult = second.claimDefinitiveRefusalFallback(secondFallback)
    expect(readOutbox(intent.sessionId)).toHaveLength(2)

    rejectLaunch(new StructuredAgentSessionCreateRefusalError('unsupported'))
    await expect(first.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(firstFallbackResult).resolves.toBe(true)
    await expect(secondFallbackResult).resolves.toBe(true)
    await expect(first.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    await expect(second.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })

    expect(firstFallback).toHaveBeenCalledOnce()
    expect(secondFallback).toHaveBeenCalledOnce()
    expect(readOutbox(intent.sessionId)).toEqual([])
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

    startStructuredCodexLaunch(worktreeId)
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledOnce())
    expect(cancelStructuredCodexLaunch(worktreeId, intent.sessionId)).toBe(true)
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

    startStructuredCodexLaunch(worktreeId, { prompt: 'first prompt' })
    startStructuredCodexLaunch(worktreeId, { prompt: 'second prompt' })
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledOnce())
    expect(readOutbox(intent.sessionId)).toHaveLength(2)

    expect(cancelStructuredCodexLaunch(worktreeId, intent.sessionId)).toBe(true)
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

    startStructuredCodexLaunch(worktreeId)
    await vi.waitFor(() => expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(2))
    expect(cancelStructuredCodexLaunch(worktreeId, intent.sessionId)).toBe(true)
    resolveRetryRefresh([])
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.abandonIntent).toHaveBeenCalledWith(intent)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
