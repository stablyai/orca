// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
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
  callStructuredAgentSession: mocks.callStructuredAgentSession
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
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
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
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 },
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
    expect(mocks.callStructuredAgentSession).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({ sessionId: fresh.sessionId }),
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'review notes' }] })
      })
    )
    // The failed chat keeps its own preserved prompt for its own Retry.
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBe('failed')
    expect(readOutbox(failed.sessionId)).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'first task' }] })
      })
    ])
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
