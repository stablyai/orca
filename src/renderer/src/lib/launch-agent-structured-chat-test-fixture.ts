import { afterEach, beforeEach, expect, vi } from 'vitest'
import {
  createTestStore,
  makeWorktree,
  makeTab,
  makeUnifiedTab,
  makeTabGroup,
  seedStore,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { drawTabsFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import type * as Frames from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { registerStructuredSelectionCatalogStore } from './structured-agent-session-selection-controller'
import type { AppState } from '@/store/types'
import type { pasteDraftWhenAgentReady } from './agent-paste-draft'
import type { waitForAgentReady } from './agent-ready-wait'
import type { createStructuredAgentSessionLaunchIntent as create } from './launch-structured-agent-session'
import type { launchStructuredAgentSession as launch } from './structured-agent-session-launch-create-call'
import type { refreshLocalStructuredSessionTabs as refreshTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import type { toast } from 'sonner'
import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'

const mockCreateTab = vi.hoisted(() => vi.fn<AppState['createTab']>())
const mockWaitForAgentReady = vi.hoisted(() => vi.fn<typeof waitForAgentReady>())
const mockPasteDraftWhenAgentReady = vi.hoisted(() => vi.fn<typeof pasteDraftWhenAgentReady>())
const mockCreateStructuredCodexSessionLaunchIntent = vi.hoisted(() =>
  vi.fn<(...args: Parameters<typeof create>) => Omit<ReturnType<typeof create>, 'agent'>>()
)
type LaunchIntent = ReturnType<typeof structuredLaunchIntent>
const mockRetryStructuredAgentSessionLaunchIntent = vi.hoisted(() =>
  vi.fn<(intent: LaunchIntent) => LaunchIntent>()
)
const mockLaunchStructuredCodexSession = vi.hoisted(() => vi.fn<typeof launch>())
type TabSnapshotFixture = { worktree: string; tabs: { type: 'agent-session'; sessionId: string }[] }
const mockRefreshLocalStructuredSessionTabs = vi.hoisted(() =>
  vi.fn<(...args: Parameters<typeof refreshTabs>) => Promise<TabSnapshotFixture[]>>()
)
const mockToastError = vi.hoisted(() => vi.fn<typeof toast.error>())
const mockCallStructuredAgentSession = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
)
const mockCreateSupport = vi.hoisted(() =>
  vi.fn<() => Promise<{ supported: boolean; reason?: string }>>()
)
const STRUCTURED_HOST_CAPABILITIES = ['agent-session.structured.v1']

const owner = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
export function liveStore() {
  if (!owner.store) {
    throw new Error('structured launch store not seeded')
  }
  return owner.store
}
const state = () => liveStore().getState()
export function currentLaunchSettings(): GlobalSettings {
  const settings = state().settings
  if (settings === null) {
    throw new Error('structured launch settings not seeded')
  }
  return settings
}
export let main: Frames.TabsDrawnFromMain
let restoreCatalog: (() => void) | undefined
function launchScenarioSettings(): GlobalSettings {
  return createGlobalSettingsFixture({
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    agentDefaultSurface: 'chat',
    nativeChatProviders: {},
    nativeChatSessionOptions: undefined,
    agentPermissionDefault: undefined,
    agentPermissionOverrides: undefined
  })
}

export function structuredLaunchIntent(worktreeId: string, sessionId = 'codex-session-1') {
  return {
    sessionId,
    worktreeId,
    executionHostId: 'local' as const,
    target: { kind: 'local' as const },
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'.repeat(64)
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex' as const
    }
  }
}

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store', async () =>
  (await import('./launch-parity-renderer.test-fixture')).launchStoreModuleMock(owner)
)
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mockToastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-ready-wait', () => ({ waitForAgentReady: mockWaitForAgentReady }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false)
}))
vi.mock('../../../shared/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))
const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  class StructuredAgentSessionHostDeclinedError extends StructuredAgentSessionCreateRefusalError {}
  class StructuredAgentSessionHostUnreachableError extends StructuredAgentSessionCreateRefusalError {}
  class StructuredAgentSessionOwnerUnresolvedError extends Error {}
  return {
    StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionHostDeclinedError,
    StructuredAgentSessionHostUnreachableError,
    StructuredAgentSessionOwnerUnresolvedError
  }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mockLaunchStructuredCodexSession
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mockCreateStructuredCodexSessionLaunchIntent,
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    retryStructuredAgentSessionLaunchIntent: mockRetryStructuredAgentSessionLaunchIntent,
    launchStructuredAgentSession: mockLaunchStructuredCodexSession,
    ...launchErrorMocks
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs
}))
vi.mock('@/runtime/local-structured-session-owner', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => STRUCTURED_HOST_CAPABILITIES,
  ensureLocalRuntimeCapabilities: async () => STRUCTURED_HOST_CAPABILITIES,
  awaitLocalRuntimeCapabilities: () => ({ known: Promise.resolve([]), stop: () => {} })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () =>
    state().repos[0]?.connectionId
      ? `ssh:${state().repos[0].connectionId}`
      : currentLaunchSettings().activeRuntimeEnvironmentId
        ? `runtime:${currentLaunchSettings().activeRuntimeEnvironmentId}`
        : 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (target: unknown, method: string, params: unknown) =>
    method === 'agentSession.createSupport'
      ? mockCreateSupport()
      : mockCallStructuredAgentSession(target, method, params)
}))

beforeEach(async () => {
  vi.resetAllMocks()
  owner.store = createTestStore()
  const chat = makeUnifiedTab({
    id: 'structured-agent-session-codex-session-1',
    contentType: 'agent-session',
    entityId: 'codex-session-1',
    worktreeId: 'wt-1',
    groupId: 'group-1'
  })
  seedStore(owner.store, {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    settings: launchScenarioSettings(),
    projects: [
      {
        id: 'repo-1',
        displayName: 'repo',
        badgeColor: '',
        sourceRepoIds: ['repo-1'],
        createdAt: 0,
        updatedAt: 0,
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ],
    repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: null, path: '/repo' }],
    sshConnectionStates: new Map(
      ['ssh-a', 'runtime-ssh-a'].map((targetId) => [
        targetId,
        {
          targetId,
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0,
          remotePlatform: 'linux' as const
        }
      ])
    ),
    runtimeStatusByEnvironmentId: new Map([
      [
        'web-runtime',
        {
          checkedAt: 0,
          status: {
            hostPlatform: 'linux',
            runtimeId: 'web-runtime',
            rendererGraphEpoch: 0,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 3,
            capabilities: STRUCTURED_HOST_CAPABILITIES
          }
        }
      ]
    ]),
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/worktree',
          projectId: 'repo-1'
        })
      ]
    },
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
    unifiedTabsByWorktree: { 'wt-1': [chat] },
    groupsByWorktree: {
      'wt-1': [
        makeTabGroup({
          id: 'group-1',
          worktreeId: 'wt-1',
          tabOrder: [chat.id],
          activeTabId: chat.id
        })
      ]
    },
    layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'group-1' } },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' }
  })
  liveStore().setState({ createTab: mockCreateTab, runtimeEnvironmentCatalogHydrated: true })
  mockCreateTab.mockReturnValue(makeTab({ id: 'tab-1', worktreeId: 'wt-1' }))
  expect(state().getTab('missing')).toBeNull()
  expect(state().getTab(chat.id)).toBe(chat)
  expect(state().readLocalAgentInventory()).toEqual({ ids: null, state: 'pending' })
  restoreCatalog = registerStructuredSelectionCatalogStore({
    read: state,
    subscribe: (listener) => liveStore().subscribe(listener)
  })
  main = await drawTabsFromMain(liveStore())
})

afterEach(() => {
  try {
    restoreCatalog?.()
    main.close()
  } finally {
    vi.restoreAllMocks()
    owner.store = null
  }
})

export {
  mockCreateTab,
  mockWaitForAgentReady,
  mockPasteDraftWhenAgentReady,
  mockCreateStructuredCodexSessionLaunchIntent,
  mockRetryStructuredAgentSessionLaunchIntent,
  mockLaunchStructuredCodexSession,
  mockRefreshLocalStructuredSessionTabs,
  mockToastError,
  mockCallStructuredAgentSession,
  launchErrorMocks,
  mockCreateSupport
}
