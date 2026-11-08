// @vitest-environment happy-dom

import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
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

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>(
    '@/lib/agent-session/launch/structured-agent-session-launch-errors'
  )),
  ...launchErrorMocks
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
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
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', async () => {
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

import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'

import {
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'

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

  it('never joins a resume of the same conversation id running on another host', async () => {
    await leaveFirstLaunchUnconfirmed({ resume: true })

    const remote = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-9',
      resumeFrom,
      executionHostId: 'runtime:server-1'
    })

    expect(remote.sessionId).not.toBe(unconfirmed.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
  })
})
