// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'

import {
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { relaunchFailedStructuredAgentSessionWithMessage } from './structured-agent-session-launch-message'
import { clearNativeChatComposerDraftsForTests as clearNativeChatDraftCacheForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'

import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/agent-session/launch/structured-agent-session-launch-intent'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  restoreIntent: vi.fn(),
  launch: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

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

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-intent', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-abandon', () => ({
  abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent
}))

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app; reads stay on this mock.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    method === 'agentSession.send'
      ? mocks.callRuntimeRpc(target, method, params)
      : mocks.callStructuredAgentSession(target, method, params)
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/store/index', () => ({
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

vi.mock('@/lib/agent-catalog/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

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

async function refuseFirstLaunch(): Promise<void> {
  mocks.createIntent.mockReturnValueOnce(failed)
  mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
  startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-1', prompt: 'first task' })
  await flushLaunchSettlement()
  expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, failed.sessionId)).toBe('failed')
}

// A message sent into a chat whose start failed rides the restart, held until the chat exists.
describe('a message sent to a chat whose start failed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => intent)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(failed.sessionId)
    ])
    mocks.callRuntimeRpc.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  async function failThenTakeComposerText(): Promise<void> {
    await refuseFirstLaunch()
    clearNativeChatDraftCacheForTests()
  }

  it('restarts the chat and delivers the message once it publishes, never before', async () => {
    await failThenTakeComposerText()
    let publish = (_receipt: Receipt): void => {}
    mocks.launch.mockReturnValueOnce(new Promise<Receipt>((resolve) => (publish = resolve)))

    const delivery = relaunchFailedStructuredAgentSessionWithMessage(
      WORKTREE_ID,
      failed.sessionId,
      'restart and say hi'
    )
    expect(delivery).not.toBeNull()
    expect(mocks.retryIntent).toHaveBeenCalledOnce()
    // Held in the chat's one send slot, drawn as sending; nothing typed meanwhile goes first.
    expect(getStructuredAgentSessionPendingSends(failed.sessionId).map((e) => e.phase)).toEqual([
      'sending'
    ])
    expect(
      sendStructuredAgentSessionMessage({
        sessionId: failed.sessionId,
        target: { kind: 'local' },
        text: 'typed meanwhile'
      })
    ).toBeNull()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    publish({ sessionId: failed.sessionId, fence: 1 })
    await expect(delivery).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text: 'restart and say hi' }] })
      })
    )
  })
})
