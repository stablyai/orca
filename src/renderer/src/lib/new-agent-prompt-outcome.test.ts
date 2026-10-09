// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  createIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: (intent: unknown) => intent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.callRuntimeRpc(target, method, params)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => undefined
  }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import {
  holdNotesForSend,
  isNoteInFlight,
  resetNotesInFlightForTests
} from './notes-send-in-flight'
import { newAgentPromptOutcome } from './new-agent-prompt-outcome'

const WORKTREE_ID = 'wt-notes-new-agent'
const NOTES = 'review notes'

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

function published(sessionId: string): RuntimeMobileSessionTabsResult {
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
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

const chat = launchIntent('session-notes')

/** What the notes menu does with a "New agent" pick: the launch, then the hold on its outcome. */
function sendNotesToNewAgent() {
  const onDelivered = vi.fn()
  const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
    requestId: 'request-1',
    prompt: NOTES,
    promptDelivery: 'submit-after-ready',
    // The notes keep their text until it goes out, as the notes menu's launch says.
    promptKeptByCaller: true
  })
  holdNotesForSend(
    ['note-a'],
    newAgentPromptOutcome({ delivery: launch.promptDeliveryResult! }),
    onDelivered
  )
  return { launch, onDelivered }
}

function sentMessages(): unknown[] {
  return mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

/** A start the host refused outright: the chat shows it failed, with Retry. */
async function failTheStart(): Promise<void> {
  await settle()
  expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, chat.sessionId)).toBe('failed')
}

describe('notes sent to a new agent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetNotesInFlightForTests()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.createIntent.mockReturnValue(chat)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([published(chat.sessionId)])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('leaves the shelf once the new chat delivers them', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    const { onDelivered } = sendNotesToNewAgent()
    expect(isNoteInFlight('note-a')).toBe(true)

    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledOnce())
    expect(isNoteInFlight('note-a')).toBe(false)
  })

  // One owner of the text: the notes keep it until it goes out, so the new chat's composer never
  // gets a copy to send a second time.
  it("come back to the shelf, never into the new chat's composer, when the host refuses them", async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })
    const { onDelivered } = sendNotesToNewAgent()

    await vi.waitFor(() => expect(isNoteInFlight('note-a')).toBe(false))
    expect(onDelivered).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chat.sessionId))).toBe('')
  })

  // The notes own the text, so they are the one place that says it did not go.
  it('report the refusal once, as a send to a chat does', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })
    const { launch } = sendNotesToNewAgent()
    await expect(
      newAgentPromptOutcome({ delivery: launch.promptDeliveryResult! })
    ).resolves.toEqual({
      delivered: false,
      failure: { status: 'not-writable', code: 'session-send-refused' }
    })
  })

  it("come back to the shelf when the start fails, and only there, not in that chat's composer", async () => {
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const { onDelivered } = sendNotesToNewAgent()
    await failTheStart()

    expect(isNoteInFlight('note-a')).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chat.sessionId))).toBe('')
    expect(sentMessages()).toHaveLength(0)
  })

  it("are not sent again by that chat's Retry", async () => {
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
    sendNotesToNewAgent()
    await failTheStart()
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, chat.sessionId)).toBe(true)
    await settle()

    expect(sentMessages()).toHaveLength(0)
  })

  it('come back to the shelf when the failed chat is closed', async () => {
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const { onDelivered } = sendNotesToNewAgent()
    await failTheStart()

    cancelStructuredAgentLaunch(WORKTREE_ID, chat.sessionId)
    await settle()

    expect(isNoteInFlight('note-a')).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
  })

  it('come back when a chat still starting is closed, without waiting on its create', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const { onDelivered } = sendNotesToNewAgent()

    cancelStructuredAgentLaunch(WORKTREE_ID, chat.sessionId)
    await settle()

    expect(isNoteInFlight('note-a')).toBe(false)
    expect(onDelivered).not.toHaveBeenCalled()
  })
})

describe('why notes sent to a new agent did not go', () => {
  it.each([
    [
      'nobody could confirm it',
      { delivered: false, failureNotified: false, unconfirmed: true as const },
      { status: 'unconfirmed', code: 'runtime-unverifiable' }
    ],
    [
      "the chat's one send was taken",
      { delivered: false, failureNotified: false, busy: true as const },
      { status: 'not-ready', code: 'session-send-refused' }
    ],
    [
      'the host refused it',
      { delivered: false, failureNotified: false },
      { status: 'not-writable', code: 'session-send-refused' }
    ]
  ])('says so once when %s', async (_why, result, failure) => {
    await expect(newAgentPromptOutcome({ delivery: Promise.resolve(result) })).resolves.toEqual({
      delivered: false,
      failure
    })
  })

  it('leaves a failure the new chat already shows to that chat', async () => {
    await expect(
      newAgentPromptOutcome({
        delivery: Promise.resolve({ delivered: false, failureNotified: true })
      })
    ).resolves.toEqual({ delivered: false })
    await expect(
      newAgentPromptOutcome({ delivery: Promise.reject(new Error('start failed')) })
    ).resolves.toEqual({ delivered: false })
  })
})
