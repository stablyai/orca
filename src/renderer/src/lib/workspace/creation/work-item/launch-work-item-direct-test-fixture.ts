import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type * as TuiAgentSelectionModule from '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type * as TuiAgentStartupModule from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import type * as DirectAgentRoutingModule from '@/lib/workspace/creation/work-item/launch-work-item-direct-agent-routing'
import type * as RuntimeRpcSubscribeModule from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import type * as LaunchAgentKindModule from '../../../../../../shared/agent-kind'
import type * as WorkspaceNameModule from '../../../../../../shared/workspace-name'
import type * as WorkspaceSourceModule from '../../../../../../shared/new-workspace/workspace-source'

type DirectLaunchStoreActions = {
  ensureDetectedAgents: Mock
  ensureRemoteDetectedAgents: Mock
  createWorktree: Mock
  updateWorktreeMeta: Mock
  setSidebarOpen: Mock
  seedNativeChatLaunchPrompt: Mock
  seedNativeChatLaunchDraft: Mock
  markNativeChatLaunchPromptFailed: Mock
}

type DirectLaunchMocks = DirectLaunchStoreActions & {
  toastError: Mock
  activateAndRevealWorktree: Mock
  pasteDraftWhenAgentReady: Mock
  openModalFallback: Mock
  resolvePrBase: Mock
  getConnectionId: Mock
  store: Record<string, unknown> & DirectLaunchStoreActions & { repos?: Partial<Repo>[] }
}

type HostMocks = {
  checkRuntimeHooks: Mock
  callRuntimeRpc: Mock
  supports: Mock
  subscribe: Mock<typeof RuntimeRpcSubscribeModule.subscribeRuntimeRpc>
}

const mocks: DirectLaunchMocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setSidebarOpen: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  openModalFallback: vi.fn(),
  resolvePrBase: vi.fn(),
  getConnectionId: vi.fn(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test supplies the store slices its production launch reads.
  store: {} as Record<string, unknown> & DirectLaunchStoreActions
}))

vi.mock('@/store/index', async () => {
  const { createStore } = await import('zustand/vanilla')
  const { useStore } = await import('zustand')
  const store = createStore(() => mocks.store)
  Object.defineProperty(mocks, 'store', {
    get: store.getState,
    set: (state: typeof mocks.store) => {
      store.setState(state, true)
    }
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: typeof mocks.store) => unknown) => useStore(store, selector),
      store
    )
  }
})

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/runtime/repo-hooks/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run'),
  ensureHooksApproved: vi.fn().mockResolvedValue({ decision: 'run' })
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

const hostMocks: HostMocks = vi.hoisted(() => ({
  checkRuntimeHooks: vi.fn(),
  callRuntimeRpc: vi.fn(),
  supports: vi.fn(),
  subscribe: vi.fn<typeof RuntimeRpcSubscribeModule.subscribeRuntimeRpc>()
}))

vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({
  checkRuntimeHooks: hostMocks.checkRuntimeHooks
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: hostMocks.callRuntimeRpc
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: hostMocks.supports,
  runtimeEnvironmentSupportsCapabilities: async (_host: string, capabilities: string[]) =>
    Promise.all(capabilities.map((capability) => hostMocks.supports(_host, capability)))
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: async () => null
}))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: hostMocks.subscribe
}))

vi.mock('@/lib/workspace/creation/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32',
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? ''
}))
vi.mock('../../../../../../shared/workspace-name', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceNameModule>()),
  getWorkspaceIntentName: (args: {
    workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
  }) =>
    args.workItem
      ? {
          displayName:
            args.workItem.type === 'pr'
              ? `Review PR ${args.workItem.number}`
              : `Issue ${args.workItem.number}`,
          seedName:
            args.workItem.type === 'pr'
              ? `review-pr-${args.workItem.number}`
              : `issue-${args.workItem.number}`
        }
      : null
}))
vi.mock('../../../../../../shared/new-workspace/workspace-source', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceSourceModule>()),
  isGitLabIssueUrl: vi.fn(() => false)
}))

vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
const mockLaunchAgentKind = vi.hoisted(() => (agent: string) => agent)
vi.mock('../../../../../../shared/agent-kind', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAgentKindModule>()),
  tuiAgentToAgentKind: mockLaunchAgentKind
}))

vi.mock('../../../../../../shared/agent-launch/startup/tui-agent-startup', async () => {
  const actual = await vi.importActual<typeof TuiAgentStartupModule>(
    '../../../../../../shared/agent-launch/startup/tui-agent-startup'
  )
  return {
    ...actual,
    buildAgentDraftLaunchPlan: vi.fn(actual.buildAgentDraftLaunchPlan),
    buildAgentStartupPlan: vi.fn(actual.buildAgentStartupPlan)
  }
})

vi.mock('../../../../../../shared/agent-launch/catalog/tui-agent-selection', async () => {
  const actual = await vi.importActual<typeof TuiAgentSelectionModule>(
    '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
  )
  return {
    ...actual,
    pickTuiAgent: vi.fn(actual.pickTuiAgent)
  }
})

vi.mock('@/lib/workspace/creation/work-item/launch-work-item-direct-agent-routing', async () => {
  const actual = await vi.importActual<typeof DirectAgentRoutingModule>(
    '@/lib/workspace/creation/work-item/launch-work-item-direct-agent-routing'
  )
  return {
    ...actual,
    beginDirectWorkItemStructuredLaunch: vi.fn(actual.beginDirectWorkItemStructuredLaunch)
  }
})

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.clearAllMocks()
  hostMocks.callRuntimeRpc.mockReset().mockResolvedValue({ agents: [] })
  hostMocks.supports.mockReset().mockResolvedValue(false)
  hostMocks.subscribe.mockReset()
  const testWindow = typeof window === 'undefined' ? {} : window
  vi.stubGlobal(
    'window',
    Object.assign(testWindow, {
      api: {
        worktrees: {
          resolvePrBase: mocks.resolvePrBase
        }
      }
    })
  )
  hostMocks.checkRuntimeHooks.mockResolvedValue({
    hasHooks: false,
    hooks: null,
    mayNeedUpdate: false
  })
  mocks.resolvePrBase.mockResolvedValue({
    baseBranch: 'abc123',
    compareBaseRef: 'refs/remotes/origin/main',
    headSha: 'abc123',
    branchNameOverride: 'feature/fix',
    pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
  })
  mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
  mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
  mocks.getConnectionId.mockReturnValue(null)
  mocks.createWorktree.mockResolvedValue({
    worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
    setup: undefined
  })
  mocks.updateWorktreeMeta.mockResolvedValue(undefined)
  mocks.activateAndRevealWorktree.mockImplementation(() =>
    mocks.store.repos?.some((repo) => repo.executionHostId?.startsWith('runtime:'))
      ? { primaryTabId: null, startupAccepted: true }
      : { primaryTabId: 'tab-1' }
  )
  mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
  mocks.store = {
    projectGroups: [],
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        addedAt: 1
      }
    ],
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    worktreesByRepo: {},
    settings: {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {}
    },
    readLocalAgentInventory: () => ({ state: 'pending', ids: null }),
    ensureDetectedAgents: mocks.ensureDetectedAgents,
    ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
    createWorktree: mocks.createWorktree,
    updateWorktreeMeta: mocks.updateWorktreeMeta,
    setSidebarOpen: mocks.setSidebarOpen,
    seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
    seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
    markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
  }
  // Why: SSH fixtures use target `ssh-1`, which reports a Linux host once connected.
  mocks.store.sshConnectionStates = new Map([
    [
      'ssh-1',
      {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        remotePlatform: 'linux'
      }
    ]
  ])
  mocks.store.sshStateByEnvironment = new Map()
  mocks.store.runtimeStatusByEnvironmentId = new Map()
})

export { mocks, hostMocks }
