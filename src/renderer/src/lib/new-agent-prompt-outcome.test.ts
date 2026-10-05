// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  callStructuredAgentSession: vi.fn(),
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

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
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
import {
  mutateStructuredAgentSessionLaunchPrompt,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
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
function sendNotesToNewAgent(options: { paired?: boolean } = {}) {
  const onDelivered = vi.fn()
  const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
    requestId: 'request-1',
    prompt: NOTES,
    promptDelivery: 'submit-after-ready'
  })
  holdNotesForSend(
    ['note-a'],
    newAgentPromptOutcome({
      prompt: NOTES,
      ...(options.paired ? {} : { sessionId: launch.sessionId }),
      delivery: launch.promptDeliveryResult!
    }),
    onDelivered
  )
  return { launch, onDelivered }
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
    mocks.createIntent.mockReturnValue(chat)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([published(chat.sessionId)])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('leaves the shelf once the new chat delivers them', async () => {
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })
    const { onDelivered } = sendNotesToNewAgent()
    expect(isNoteInFlight('note-a')).toBe(true)

    await settle()

    expect(onDelivered).toHaveBeenCalledOnce()
    expect(isNoteInFlight('note-a')).toBe(false)
  })

  it('stay held, not resendable, while a failed chat keeps them for its Retry', async () => {
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const { onDelivered } = sendNotesToNewAgent()
    await failTheStart()

    expect(readOutbox(chat.sessionId)).toHaveLength(1)
    expect(isNoteInFlight('note-a')).toBe(true)
    expect(onDelivered).not.toHaveBeenCalled()
  })

  it("leave the shelf when that chat's Retry delivers them", async () => {
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
    const { onDelivered } = sendNotesToNewAgent()
    await failTheStart()
    mocks.launch.mockResolvedValue({ sessionId: chat.sessionId, fence: 1 })

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, chat.sessionId)).toBe(true)
    await settle()
    // The open chat's own send accepts the staged prompt, as every dispatch does.
    const [entry] = readOutbox(chat.sessionId)
    mutateStructuredAgentSessionLaunchPrompt(chat.sessionId, entry.clientMessageId, () => null)
    await settle()

    expect(onDelivered).toHaveBeenCalledOnce()
    expect(isNoteInFlight('note-a')).toBe(false)
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

  it("stay held by a paired server's failed chat, found once its start settles", async () => {
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))
    sendNotesToNewAgent({ paired: true })
    await failTheStart()

    expect(isNoteInFlight('note-a')).toBe(true)
  })
})
