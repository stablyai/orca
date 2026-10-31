// @vitest-environment happy-dom

import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type * as RecoveryModule from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

type LaunchMocks = Record<
  | 'abandonIntent'
  | 'callStructuredAgentSession'
  | 'callRuntimeRpc'
  | 'createIntent'
  | 'retryIntent'
  | 'restoreIntent'
  | 'launch'
  | 'seedDraft'
  | 'clearDraft',
  Mock
> & {
  rendererTabs: Record<string, unknown[]>
  listeners: Set<(state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void>
}

const mocks: LaunchMocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
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

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
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

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app; reads stay on this mock.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    method === 'agentSession.send'
      ? mocks.callRuntimeRpc(target, method, params)
      : mocks.callStructuredAgentSession(target, method, params)
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeEnvironmentCatalogHydrated: true,
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

import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { useAppStore } from '@/store'
import { registerStructuredSelectionCatalogStore } from './structured-agent-session-selection-controller'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    executionHostId: 'local',
    target: { kind: 'local' },
    sessionId,
    agent: 'codex',
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

function publishIntent(intent: StructuredAgentSessionLaunchIntent): void {
  vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
    publishedSnapshot(intent.worktreeId, intent.sessionId)
  ])
}

function sends(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'agentSession.send')
}

function composerDraft(sessionId: string): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

let restoreCatalog: () => void
afterEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  replaceRuntimeEnvironmentRevisions([])
  restoreCatalog()
})

beforeEach(() => {
  vi.resetAllMocks()
  restoreCatalog = registerStructuredSelectionCatalogStore({
    read: useAppStore.getState,
    subscribe: useAppStore.subscribe
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 1, pairingRevision: 1 }])
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentSessionSendsForTests()
  clearNativeChatDraftCacheForTests()
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
  mocks.callRuntimeRpc.mockResolvedValue({
    ok: true,
    value: { submission: { dispatchState: 'accepted' } }
  })
})

export {
  mocks,
  launchIntent,
  publishedSnapshot,
  publishIntent,
  sends,
  composerDraft,
  flushLaunchSettlement
}
