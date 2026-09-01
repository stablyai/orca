import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  launch: vi.fn()
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
    launchStructuredCodexSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { startStructuredCodexLaunch } from './structured-agent-session-launch'

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
    mocks.createIntent.mockImplementation((worktreeId: string) => launchIntent(worktreeId))
  })

  it('opens the chat without an informational progress toast', async () => {
    const worktreeId = 'wt-open-quiet'
    const intent = launchIntent(worktreeId, 'session-1')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue(intent.sessionId)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('coalesces a duplicate click silently while the launch is in flight', async () => {
    const worktreeId = 'wt-duplicate-click'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (sessionId: string) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () => new Promise<string>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    startStructuredCodexLaunch(worktreeId)

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    resolveLaunch(intent.sessionId)
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
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
      .mockResolvedValueOnce(intent.sessionId)
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

  it('releases a definitively refused intent so a new click can create a new identity', async () => {
    const worktreeId = 'wt-refused'
    const first = launchIntent(worktreeId, 'session-first')
    const second = launchIntent(worktreeId, 'session-second')
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce(second.sessionId)
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
})
