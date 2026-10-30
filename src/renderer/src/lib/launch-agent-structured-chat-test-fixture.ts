import { beforeEach, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { pasteDraftWhenAgentReady } from './agent-paste-draft'
import type { waitForAgentReady } from './agent-ready-wait'
import type { createStructuredAgentSessionLaunchIntent as createIntent } from './launch-structured-agent-session'
import type { launchStructuredAgentSession } from './structured-agent-session-launch-create-call'
import type { refreshLocalStructuredSessionTabs as refreshTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import type { toast } from 'sonner'
import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'

export const mockCreateTab = vi.fn<(...args: Parameters<AppState['createTab']>) => { id: string }>()
export const mockCreateUnifiedTab = vi.fn<
  (
    worktreeId: string,
    contentType: string,
    init: Pick<UnifiedTabFixture, 'id' | 'entityId' | 'agentSessionAgent' | 'label'> & {
      targetGroupId?: string
    }
  ) => UnifiedTabFixture
>()
const mockSetTabViewMode = vi.fn<AppState['setTabViewMode']>()
export const mockWaitForAgentReady = vi.fn<typeof waitForAgentReady>()
export const mockPasteDraftWhenAgentReady = vi.fn<typeof pasteDraftWhenAgentReady>()
const mockMarkNativeChatLaunchPromptFailed = vi.fn<AppState['markNativeChatLaunchPromptFailed']>()
export const mockCreateStructuredCodexSessionLaunchIntent =
  vi.fn<
    (...args: Parameters<typeof createIntent>) => Omit<ReturnType<typeof createIntent>, 'agent'>
  >()
const mockAbandonStructuredAgentSessionLaunchIntent = vi.fn()
export const mockRetryStructuredAgentSessionLaunchIntent =
  vi.fn<
    (intent: ReturnType<typeof structuredLaunchIntent>) => ReturnType<typeof structuredLaunchIntent>
  >()
export const mockLaunchStructuredCodexSession = vi.fn<typeof launchStructuredAgentSession>()
type TabSnapshotFixture = { worktree: string; tabs: { type: 'agent-session'; sessionId: string }[] }
export const mockRefreshLocalStructuredSessionTabs =
  vi.fn<(...args: Parameters<typeof refreshTabs>) => Promise<TabSnapshotFixture[]>>()
export const mockToastError = vi.fn<typeof toast.error>()
export const mockCallStructuredAgentSession =
  vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
export const mockCreateSupport = vi.fn<() => Promise<{ supported: boolean; reason?: string }>>()
const STRUCTURED_HOST_CAPABILITIES = ['agent-session.structured.v1']
let hostCapabilities: readonly string[] | null = STRUCTURED_HOST_CAPABILITIES

type UnifiedTabFixture = {
  id: string
  contentType: string
  entityId: string
  worktreeId: string
  groupId: string
  agentSessionAgent?: string
  label?: string
}
const emptyUnifiedTabsByWorktree: Record<string, UnifiedTabFixture[]> = {}
type StructuredLaunchFixtureSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat: boolean
  nativeChatProviders: Record<string, boolean>
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string | boolean>> }
  >
}
const settings: StructuredLaunchFixtureSettings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  activeRuntimeEnvironmentId: null,
  experimentalNativeChat: true,
  nativeChatProviders: {},
  nativeChatSessionOptions: undefined
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

export const store = {
  clearNativeChatLaunchDraft: vi.fn<AppState['clearNativeChatLaunchDraft']>(),
  readLocalAgentInventory: () => ({ ids: null, state: 'pending' }),
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings,
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map([
    ['ssh-a', { status: 'connected', remotePlatform: 'linux' }],
    ['runtime-ssh-a', { status: 'connected', remotePlatform: 'linux' }]
  ]),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map([
    [
      'web-runtime',
      { status: { hostPlatform: 'linux', capabilities: STRUCTURED_HOST_CAPABILITIES } }
    ]
  ]),
  transientClearedAgentStatusConnectionIds: {},
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', projectId: 'repo-1', path: '/repo/worktree' }]
  },
  detectedWorktreesByRepo: {},
  allWorktrees: vi.fn<() => { id: string; repoId: string; projectId: string; path: string }[]>(
    () => store.worktreesByRepo['repo-1']
  ),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  unifiedTabsByWorktree: emptyUnifiedTabsByWorktree,
  groupsByWorktree: {},
  layoutByWorktree: {},
  activeGroupIdByWorktree: {},
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  createTab: mockCreateTab,
  createUnifiedTab: mockCreateUnifiedTab,
  closeTab: vi.fn<AppState['closeTab']>(),
  queueTabStartupCommand: vi.fn<AppState['queueTabStartupCommand']>(),
  setActiveTabType: vi.fn<AppState['setActiveTabType']>(),
  focusGroup: vi.fn<AppState['focusGroup']>(),
  activateTab: vi.fn<AppState['activateTab']>(),
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: vi.fn<AppState['setTabBarOrder']>(),
  setAgentStatus: vi.fn<AppState['setAgentStatus']>(),
  seedNativeChatLaunchPrompt: vi.fn<AppState['seedNativeChatLaunchPrompt']>(),
  seedNativeChatLaunchDraft: vi.fn<AppState['seedNativeChatLaunchDraft']>(),
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
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
    abandonStructuredAgentSessionLaunchIntent: mockAbandonStructuredAgentSessionLaunchIntent,
    retryStructuredAgentSessionLaunchIntent: mockRetryStructuredAgentSessionLaunchIntent,
    launchStructuredAgentSession: mockLaunchStructuredCodexSession,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionHostDeclinedError:
      launchErrorMocks.StructuredAgentSessionHostDeclinedError,
    StructuredAgentSessionHostUnreachableError:
      launchErrorMocks.StructuredAgentSessionHostUnreachableError,
    StructuredAgentSessionOwnerUnresolvedError:
      launchErrorMocks.StructuredAgentSessionOwnerUnresolvedError
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs
}))
vi.mock('@/runtime/local-structured-session-owner', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => hostCapabilities,
  ensureLocalRuntimeCapabilities: async () => hostCapabilities,
  awaitLocalRuntimeCapabilities: () => ({ known: Promise.resolve([]), stop: () => {} })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () =>
    store.repos[0]?.connectionId
      ? `ssh:${store.repos[0].connectionId}`
      : store.settings.activeRuntimeEnvironmentId
        ? `runtime:${store.settings.activeRuntimeEnvironmentId}`
        : 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (target: unknown, method: string, params: unknown) =>
    method === 'agentSession.createSupport'
      ? mockCreateSupport()
      : mockCallStructuredAgentSession(target, method, params)
}))

beforeEach(() => {
  vi.resetAllMocks()
  store.unifiedTabsByWorktree = {
    'wt-1': [
      {
        id: 'structured-agent-session-codex-session-1',
        contentType: 'agent-session',
        entityId: 'codex-session-1',
        worktreeId: 'wt-1',
        groupId: 'group-1'
      }
    ]
  }
  store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
  store.projects = [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }]
  mockCreateTab.mockReturnValue({ id: 'tab-1' })
  mockCreateUnifiedTab.mockImplementation((worktreeId, contentType, init) => {
    const tab = {
      id: init.id,
      entityId: init.entityId,
      contentType,
      worktreeId,
      groupId: init.targetGroupId ?? 'group-1',
      ...(init.agentSessionAgent ? { agentSessionAgent: init.agentSessionAgent } : {}),
      ...(init.label ? { label: init.label } : {})
    }
    store.unifiedTabsByWorktree[worktreeId] = [
      ...(store.unifiedTabsByWorktree[worktreeId] ?? []),
      tab
    ]
    return tab
  })
  mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
  mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  mockCreateStructuredCodexSessionLaunchIntent.mockImplementation((worktreeId: string) =>
    structuredLaunchIntent(worktreeId)
  )
  mockRetryStructuredAgentSessionLaunchIntent.mockImplementation((intent) => ({
    ...intent,
    params: {
      ...intent.params,
      envelope: {
        ...intent.params.envelope,
        clientOperationId: `${intent.params.envelope.clientOperationId}-retry`
      }
    }
  }))
  mockLaunchStructuredCodexSession.mockResolvedValue({
    sessionId: 'codex-session-1',
    fence: 1
  })
  mockCallStructuredAgentSession.mockResolvedValue({
    ok: true,
    page: { fence: 1 },
    value: { submission: { dispatchState: 'accepted' } }
  })
  mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
    {
      worktree: 'wt-1',
      tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }]
    }
  ])
  mockCreateSupport.mockResolvedValue({ supported: true })
  hostCapabilities = STRUCTURED_HOST_CAPABILITIES
  store.settings.activeRuntimeEnvironmentId = null
  store.settings.nativeChatProviders = {}
  store.settings.experimentalNativeChat = true
  store.settings.nativeChatSessionOptions = undefined
})

export function setHostCapabilities(value: readonly string[] | null) {
  hostCapabilities = value
}

export function structuredLaunchErrorMocks() {
  return launchErrorMocks
}
