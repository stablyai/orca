import type { structuredLaunchIntent } from './structured-session-launch-intent.test-fixture'
import { afterEach, beforeEach, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/tabs/tab-group.test-fixture'
import { drawTabsFromMain } from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import type * as Frames from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { registerStructuredSelectionCatalogStore } from '../../options/structured-agent-session-selection-controller'
import type { AppState } from '@/store/types'
import type { pasteDraftWhenAgentReady } from '../../messaging/paste/agent-paste-draft'
import type { waitForAgentReady } from '../../messaging/paste/agent-ready-wait'
import type { createStructuredAgentSessionLaunchIntent as create } from '../../../launch-structured-agent-session'
import type { launchStructuredAgentSession as launch } from '../structured-agent-session-launch-create-call'
import type { refreshLocalStructuredSessionTabs as refreshTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import type { toast } from 'sonner'
import type * as WebEnvironment from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import type * as TerminalSurface from '../../../../../../shared/workspace-layout/terminal-surface-id'
import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type * as LaunchAgentKindModule from '../../../../../../shared/agent-kind'

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

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store/index', async () =>
  (await import('../../../launch-parity-renderer.test-fixture')).launchStoreModuleMock(owner)
)
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mockToastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-ready-wait', () => ({
  waitForAgentReady: mockWaitForAgentReady
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
const mockLaunchAgentKind = vi.hoisted(() => (agent: string) => agent)
vi.mock('../../../../../../shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock(
  '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment',
  async (original) => ({
    ...(await original<typeof WebEnvironment>()),
    isWebRuntimeSessionActive: vi.fn(() => false)
  })
)
vi.mock('../../../../../../shared/workspace-layout/terminal-surface-id', async (original) => ({
  ...(await original<typeof TerminalSurface>()),
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

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-errors', async (original) => ({
  ...(await original<typeof LaunchErrors>()),
  ...launchErrorMocks
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mockLaunchStructuredCodexSession
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  createStructuredAgentSessionLaunchIntent: mockCreateStructuredCodexSessionLaunchIntent,
  abandonStructuredAgentSessionLaunchIntent: vi.fn(),
  retryStructuredAgentSessionLaunchIntent: mockRetryStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession: mockLaunchStructuredCodexSession,
  ...launchErrorMocks
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs
}))
vi.mock('@/runtime/native-chat/local-sessions/local-structured-session-owner', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => STRUCTURED_HOST_CAPABILITIES,
  ensureLocalRuntimeCapabilities: async () => STRUCTURED_HOST_CAPABILITIES,
  awaitLocalRuntimeCapabilities: () => ({ known: Promise.resolve([]), stop: () => {} })
}))
// The scenario's workspace owner: its repo's SSH connection, else the runtime it names, else local.
function scenarioOwnerHostId(): string {
  const { connectionId } = state().repos[0] ?? {}
  const runtime = currentLaunchSettings().activeRuntimeEnvironmentId
  return connectionId ? `ssh:${connectionId}` : runtime ? `runtime:${runtime}` : 'local'
}
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: scenarioOwnerHostId,
  // The menu's readiness reads the same owner as the launch, as the real module's twin does.
  getResourceExecutionHostIdForWorktree: scenarioOwnerHostId,
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
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
