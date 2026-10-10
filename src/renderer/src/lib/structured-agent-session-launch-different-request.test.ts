// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
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
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.callRuntimeRpc(target, method, params)
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

import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  getStructuredAgentSessionLaunchLifecycle,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-different-request'

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
      type: 'agent-session',
      id: `tab-${sessionId}`,
      title: 'Codex',
      sessionId,
      agent: 'codex',
      isActive: false
    }))
  }
}

const first = launchIntent('session-first')
const second = launchIntent('session-second')

/** Clears what earlier tests' launches still hold in memory under these chats. */
function resetSends(): void {
  resetStructuredAgentSessionSendsForTests()
  clearNativeChatDraftCacheForTests()
  for (const sessionId of ['session-first', 'session-second', 'session-third']) {
    discardStructuredLaunchPrompts(sessionId)
  }
}

/** Every `agentSession.send` as [session, text]. */
function sends(): [string, string][] {
  return mocks.callRuntimeRpc.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) => [call[2].envelope.sessionId, call[2].body.blocks[0].text])
}

describe('a different action while the first chat is still starting', () => {
  let resolveFirstLaunch!: (receipt: { sessionId: string; fence: number }) => void

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetSends()
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      intent.sessionId === first.sessionId
        ? new Promise((resolve) => (resolveFirstLaunch = resolve))
        : Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId, second.sessionId)
    ])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('opens a new chat with its own text while the first create is in flight', async () => {
    const checkA = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-check-a-click',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    const checkB = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-check-b-click',
      prompt: 'Fix check B',
      promptDelivery: 'submit-after-ready'
    })

    expect(checkB.sessionId).toBe(second.sessionId)
    await expect(checkB.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })
    await expect(checkA.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([
      [second.sessionId, 'Fix check B'],
      [first.sessionId, 'Fix check A']
    ])
  })

  it('opens a new chat with its own text while the first chat is still sending its text', async () => {
    let resolveFirstSend!: (result: unknown) => void
    mocks.callRuntimeRpc.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirstSend = resolve))
    )
    const checkA = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-check-a-click',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })
    await vi.waitFor(() => expect(sends()).toEqual([[first.sessionId, 'Fix check A']]))

    const checkB = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-check-b-click',
      prompt: 'Fix check B',
      promptDelivery: 'submit-after-ready'
    })

    expect(checkB.sessionId).toBe(second.sessionId)
    await expect(checkB.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    resolveFirstSend({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    await expect(checkA.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([
      [first.sessionId, 'Fix check A'],
      [second.sessionId, 'Fix check B']
    ])
  })

  it('opens two chats for two actions with identical text', async () => {
    const firstClick = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click-1',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    const secondClick = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click-2',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(secondClick.sessionId).toBe(second.sessionId)
    for (const click of [firstClick, secondClick]) {
      await expect(click.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual(
      expect.arrayContaining([
        [first.sessionId, 'Fix check A'],
        [second.sessionId, 'Fix check A']
      ])
    )
    expect(sends()).toHaveLength(2)
  })
})

describe('one action delivered twice while its chat is still starting', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetSends()
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId, second.sessionId)
    ])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('makes one chat from a pick delivered twice with no text', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))

    const pick = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'pick' })
    const again = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'pick',
      promptDelivery: 'submit-after-ready'
    })

    expect(again.sessionId).toBe(pick.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  it('makes one chat and sends its text once while the create is in flight', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))
    const onFirstDelivered = vi.fn()
    const onRepeatDelivered = vi.fn()

    const click = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: onFirstDelivered
    })
    const repeat = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: onRepeatDelivered
    })
    resolveLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(repeat.sessionId).toBe(click.sessionId)
    for (const caller of [click, repeat]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual([[first.sessionId, 'Fix check A']])
    expect(onFirstDelivered).toHaveBeenCalledOnce()
    expect(onRepeatDelivered).toHaveBeenCalledOnce()
  })

  // "Fix with AI" builds its text from logs fetched at click time; a re-delivery of that one click
  // can carry newer logs and is still the same request.
  it("makes one chat that sends the first delivery's text once when a re-delivery carries other text", async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))

    const click = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click',
      prompt: 'Fix check A (logs at 10:00)',
      promptDelivery: 'submit-after-ready'
    })
    const redelivery = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click',
      prompt: 'Fix check A (logs at 10:01)',
      promptDelivery: 'submit-after-ready'
    })
    resolveLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(redelivery.sessionId).toBe(click.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    for (const caller of [click, redelivery]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual([[first.sessionId, 'Fix check A (logs at 10:00)']])
    expect(hasStagedStructuredLaunchPrompt(first.sessionId)).toBe(false)
  })

  it('seeds a repeated draft once', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))

    const click = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'continue-click',
      prompt: 'PR context',
      promptDelivery: 'draft'
    })
    const repeat = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'continue-click',
      prompt: 'PR context',
      promptDelivery: 'draft'
    })

    expect(repeat.sessionId).toBe(click.sessionId)
    expect(mocks.seedDraft).toHaveBeenCalledOnce()
  })

  it('opens a new chat for a click after the start failed', async () => {
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
      .mockImplementation(() => new Promise(() => undefined))

    const failed = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click-1',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    await expect(failed.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    const reclick = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'fix-click-2',
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })

    expect(reclick.sessionId).toBe(second.sessionId)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, first.sessionId)).toBe('failed')
    expect(hasStagedStructuredLaunchPrompt(second.sessionId)).toBe(true)
    // The failed chat's text waits in its own composer.
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(first.sessionId))).toBe(
      'Fix check A'
    )
  })
})

describe('an action with text beside an empty chat still starting', () => {
  let resolveFirstLaunch!: (receipt: { sessionId: string; fence: number }) => void
  const notesSend = {
    requestId: 'notes-send',
    prompt: 'review notes',
    promptDelivery: 'submit-after-ready'
  } as const

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetSends()
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      intent.sessionId === first.sessionId
        ? new Promise((resolve) => (resolveFirstLaunch = resolve))
        : Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId, second.sessionId)
    ])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('opens its own chat for notes sent to a new agent', async () => {
    const blank = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' })

    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesSend)
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(blank.sessionId).toBe(first.sessionId)
    expect(notes.sessionId).toBe(second.sessionId)
    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([[second.sessionId, 'review notes']])
    expect(hasStagedStructuredLaunchPrompt(blank.sessionId)).toBe(false)
  })

  it('sends notes delivered twice once, in their own chat', async () => {
    const blank = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' })
    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesSend)
    const again = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesSend)
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(again.sessionId).toBe(notes.sessionId)
    expect(notes.sessionId).not.toBe(blank.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    for (const caller of [notes, again]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual([[second.sessionId, 'review notes']])
  })

  it('leaves the empty chat to its own pick, whose re-delivery still joins it', () => {
    const blank = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesSend)

    const again = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'plus-pick' })

    expect(again.sessionId).toBe(blank.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
  })
})
