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
  clearDraft: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

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

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

// The structured route hands the launch's own delivery result back unchanged.
vi.mock('@/lib/launch-agent-in-new-tab', async () => {
  const launch = await import('./structured-agent-session-launch')
  return {
    launchAgentInNewTab: (args: {
      requestId: string
      worktreeId: string
      prompt: string
      promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
    }) => {
      const started = launch.startStructuredAgentLaunch(args.worktreeId, 'codex', {
        requestId: args.requestId,
        prompt: args.prompt,
        promptDelivery: args.promptDelivery
      })
      return {
        surface: { kind: 'agent-session', sessionId: started.sessionId },
        ...(started.promptDeliveryResult
          ? { promptDeliveryResult: started.promptDeliveryResult }
          : {})
      }
    }
  }
})

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { runSourceControlAgentActionStart } from '@/components/right-sidebar/runSourceControlAgentActionStart'
import {
  getStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-unconfirmed-or-retried'

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

function publishedSnapshot(sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: `tab-${sessionId}`,
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

const unconfirmed = launchIntent('session-unconfirmed')
const fresh = launchIntent('session-new')
const resumeFrom = { providerSessionId: 'provider-1' }

/** The create's answer is lost and inventory never shows the chat: it stays unconfirmed. */
async function leaveFirstLaunchUnconfirmed(options: { resume?: boolean } = {}): Promise<void> {
  mocks.createIntent
    .mockReturnValueOnce(
      options.resume
        ? { ...unconfirmed, params: { ...unconfirmed.params, resumeFrom } }
        : unconfirmed
    )
    .mockReturnValueOnce(fresh)
  startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
    requestId: 'request-1',
    prompt: 'first task',
    ...(options.resume ? { resumeFrom } : {})
  })
  await flushLaunchSettlement()
  expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, unconfirmed.sessionId)).toBe(
    'visibility-unknown'
  )
}

function expectSentTo(sessionId: string, text: string): void {
  expect(mocks.callStructuredAgentSession).toHaveBeenCalledWith(
    { kind: 'local' },
    'agentSession.send',
    expect.objectContaining({
      envelope: expect.objectContaining({ sessionId }),
      body: expect.objectContaining({ blocks: [{ type: 'text', text }] })
    })
  )
}

describe('a new start beside an unconfirmed or retried chat', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => intent)
    mocks.restoreIntent.mockImplementation((args: { sessionId: string }) =>
      launchIntent(args.sessionId)
    )
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      intent.sessionId === fresh.sessionId
        ? Promise.resolve({ sessionId: fresh.sessionId, fence: 1 })
        : Promise.reject(new Error('response lost'))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(fresh.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 },
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('starts a source-control agent in a new chat and reports success only once its text is sent', async () => {
    await leaveFirstLaunchUnconfirmed()
    const onLaunched = vi.fn()

    const started = await runSourceControlAgentActionStart({
      selectedAgent: 'codex',
      trimmedCommandInput: 'Fix the failing check',
      agentArgs: '',
      agentArgsApply: false,
      commandTemplate: '{basePrompt}',
      saveTargetValue: 'none',
      actionId: 'resolveComments',
      settings: null,
      repo: null,
      worktreeId: WORKTREE_ID,
      promptDelivery: 'submit-after-ready',
      launchSource: 'source_control_recovery',
      onLaunched,
      onClose: vi.fn()
    })

    expect(started).toBe(true)
    expect(onLaunched).toHaveBeenCalledOnce()
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expectSentTo(fresh.sessionId, 'Fix the failing check')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('sends notes to a new chat while another chat is unconfirmed', async () => {
    await leaveFirstLaunchUnconfirmed()

    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-2',
      prompt: 'review notes',
      promptDelivery: 'submit-after-ready'
    })

    expect(notes.sessionId).toBe(fresh.sessionId)
    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expectSentTo(fresh.sessionId, 'review notes')
    // The unconfirmed chat is left for its own re-check.
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, unconfirmed.sessionId)).toBe(
      'visibility-unknown'
    )
  })

  it("opens a new chat with its text, not a draft, while a restored chat's Retry is in flight", async () => {
    const failed = launchIntent('session-failed')
    mocks.createIntent.mockReturnValueOnce(failed).mockReturnValueOnce(fresh)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-3',
      prompt: 'first task'
    })
    await flushLaunchSettlement()
    // Reload: the registry is memory; the failed record is what survives.
    resetStructuredAgentLaunchRegistryForTests()
    mocks.launch.mockImplementationOnce(() => new Promise(() => undefined))
    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, failed.sessionId)).toBe(true)
    mocks.seedDraft.mockClear()

    const next = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-4',
      prompt: 'fix it',
      promptDelivery: 'submit-after-ready'
    })

    expect(next.sessionId).toBe(fresh.sessionId)
    await expect(next.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expectSentTo(fresh.sessionId, 'fix it')
    expect(mocks.seedDraft).not.toHaveBeenCalled()
  })

  it('opens a new chat from a + menu pick while another chat is unconfirmed', async () => {
    await leaveFirstLaunchUnconfirmed()
    // Why: the + menu disables an agent only while a pick would join a start in flight.
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('idle')

    const pick = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-5' })

    expect(pick.sessionId).toBe(fresh.sessionId)
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('pending')
    // No re-check of the unconfirmed chat: only its own two create attempts and the new one.
    expect(mocks.launch).toHaveBeenCalledTimes(3)
    await expect(pick.launchResult).resolves.toEqual({ sessionId: fresh.sessionId, fence: 1 })
  })

  it('still coalesces one action delivered twice racing for one chat', async () => {
    mocks.createIntent.mockReturnValueOnce(fresh)
    mocks.launch.mockImplementationOnce(() => new Promise(() => undefined))

    const first = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'double-click',
      prompt: 'one'
    })
    const second = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'double-click',
      prompt: 'one'
    })

    expect(second.sessionId).toBe(first.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  it('still re-checks an unconfirmed resume instead of adopting its conversation twice', async () => {
    await leaveFirstLaunchUnconfirmed({ resume: true })
    expect(getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex')).toBe('unknown')

    expect(
      startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-8', resumeFrom })
        .sessionId
    ).toBe(unconfirmed.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })
})
