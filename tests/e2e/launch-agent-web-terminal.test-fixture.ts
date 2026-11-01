import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import type * as TerminalOperation from '@/runtime/web-runtime-terminal-create-operation'
import type * as WebEnvironment from '@/runtime/web-runtime-session-environment'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type { AgentLaunchChoices } from '../../src/shared/agent-launch-choices'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../src/shared/project-group-types'

const mocks = vi.hoisted(() => ({
  actualOperation: false,
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  clipboard: vi.fn(),
  reveal: vi.fn(),
  capability: vi.fn<typeof RuntimeRpcClient.runtimeEnvironmentSupportsCapability>(
    async () => false
  ),
  hostRpc: vi.fn()
}))

const choices: AgentLaunchChoices = {}
const nativeChatProviders: Record<string, boolean> = {}
const folderWorkspaces: FolderWorkspace[] = []
const projectGroups: ProjectGroup[] = []
const hostStatuses = new Map<
  string,
  { status: { hostPlatform: string; capabilities: string[]; runtimeId?: string } }
>([['web-runtime', { status: { hostPlatform: 'linux', capabilities: [] } }]])
export const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentLaunchChoices: choices,
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    nativeChatProviders,
    activeRuntimeEnvironmentId: 'web-runtime' as string | null
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  folderWorkspaces,
  projectGroups,
  // The client stamps a server's rows on arrival; focus alone never names the owner.
  repos: [
    { id: 'repo-1', connectionId: null, path: '/repo', executionHostId: 'runtime:web-runtime' }
  ],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main',
        branch: 'main'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] as { id: string; launchAgent?: string }[] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: hostStatuses,
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  getKnownWorktreeById: (id: string) =>
    store.worktreesByRepo['repo-1'].find((row) => row.id === id),
  createWorktree: vi.fn(async () => {
    const worktree = { ...store.worktreesByRepo['repo-1'][0], id: 'wt-fork', path: '/repo/fork' }
    store.worktreesByRepo = { 'repo-1': [...store.worktreesByRepo['repo-1'], worktree] }
    return { worktree }
  }),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setActiveWorktree: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.capability,
  callRuntimeRpc: mocks.hostRpc
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: mocks.toastError, success: mocks.toastSuccess }
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.reveal }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalOperation>()
  return {
    createWebRuntimeSessionTerminalResult: (
      ...args: Parameters<typeof actual.createWebRuntimeSessionTerminalResult>
    ) =>
      mocks.actualOperation
        ? actual.createWebRuntimeSessionTerminalResult(...args)
        : mocks.createWebRuntimeSessionTerminal(...args)
  }
})
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
}))
vi.mock('@/runtime/web-runtime-terminal-placement-settlement', () => ({
  settleWebRuntimeTerminalPlacement: vi.fn(async () => {})
}))
vi.mock('@/runtime/web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebEnvironment>()),
  isWebRuntimeSessionActive: vi.fn(() => true)
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualOperation = false
  store.folderWorkspaces = []
  store.projectGroups = []
  vi.mocked(isWebRuntimeSessionActive).mockReturnValue(true)
  store.worktreesByRepo = { 'repo-1': store.worktreesByRepo['repo-1'].slice(0, 1) }
  store.repos = [{ ...store.repos[0], executionHostId: 'runtime:web-runtime' }]
  clearHostAgentMenuSettingsForTests()
  resetHostStructuredAgentsForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'web-runtime', createdAt: 1 }])
  mocks.capability.mockReset().mockResolvedValue(false)
  mocks.hostRpc.mockReset()
  store.settings = {
    agentLaunchChoices: {},
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    nativeChatProviders: {},
    activeRuntimeEnvironmentId: 'web-runtime'
  }
  store.runtimeStatusByEnvironmentId = new Map([
    ['web-runtime', { status: { hostPlatform: 'linux', capabilities: [] } }]
  ])
  store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
  mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
    outcome: { status: 'created' },
    hostTabId: 'host-tab::leaf-1'
  })
})

export { mocks }
