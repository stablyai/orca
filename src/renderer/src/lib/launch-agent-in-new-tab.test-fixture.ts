import { beforeEach, type Mock, vi } from 'vitest'
import type { Project } from '../../../shared/project-types'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

const mockCreateTab: Mock = vi.fn()
function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
const mockSetActiveTabType: Mock = vi.fn()
const mockSetTabViewMode: Mock = vi.fn()
const mockSetTabBarOrder: Mock = vi.fn()
const mockSetAgentStatus: Mock = vi.fn()
const mockPasteDraftWhenAgentReady: Mock = vi.fn()
const mockSeedNativeChatLaunchPrompt: Mock = vi.fn()
const mockSeedNativeChatLaunchDraft: Mock = vi.fn()
const mockMarkNativeChatLaunchPromptFailed: Mock = vi.fn()
const mockTrack: Mock = vi.fn()
const mockToastMessage: Mock = vi.fn()
const mockWaitForAgentReady: Mock = vi.fn()

const mockCloseTab: Mock = vi.fn()

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const initialProjects: Pick<Project, 'id' | 'localWindowsRuntimePreference'>[] = [
  { id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }
]

const settings: {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  terminalWindowsShell?: string
  nativeChatProviders?: Readonly<Record<string, boolean>>
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string | boolean>> }
  >
} = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  activeRuntimeEnvironmentId: null
}

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings,
  projects: initialProjects,
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map([
    ['ssh-a', { status: 'connected', remotePlatform: 'linux' }],
    ['ssh-target-1', { status: 'connected', remotePlatform: 'linux' }]
  ]),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map([['web-runtime', { status: { hostPlatform: 'linux' } }]]),
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: mockCloseTab,
  setActiveTabType: mockSetActiveTabType,
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  seedNativeChatLaunchDraft: mockSeedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'tab-1' }))
vi.mock('@/lib/agent-launch-pane-start', () => ({ awaitAgentLaunchPaneStart: async () => 'pty-1' }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

const mockToastError: Mock = vi.fn()

vi.mock('sonner', () => ({
  toast: { message: mockToastMessage, error: mockToastError }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: mockWaitForAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack,
  tuiAgentToAgentKind: (agent: string) => agent
}))

const mockCreateWebRuntimeSessionTerminal: Mock = vi.fn()
const mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft: Mock = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)

vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: async (args: unknown) => ({
    outcome: await mockCreateWebRuntimeSessionTerminal(args)
  })
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mockCreateWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft:
    mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))
vi.mock('../../../shared/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

beforeEach(() => {
  vi.clearAllMocks()
  setLocalRuntimeCapabilitiesForTests([])
  mockIsWebRuntimeSessionActive.mockReturnValue(false)
  mockCreateWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({ status: 'created' })
  store.activeRepoId = 'repo-1'
  store.activeWorktreeId = 'wt-1'
  store.settings = {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null
  }
  store.projects = [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' }
    }
  ]
  store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
  store.sshConnectionStates = new Map([
    ['ssh-a', { status: 'connected', remotePlatform: 'linux' }],
    ['ssh-target-1', { status: 'connected', remotePlatform: 'linux' }]
  ])
  store.transientClearedAgentStatusConnectionIds = {}
  store.worktreesByRepo = {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  }
  store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
  store.openFiles = []
  store.browserTabsByWorktree = {}
  store.tabBarOrderByWorktree = {}
  store.terminalLayoutsByTabId = {}
  store.ptyIdsByTabId = {}
  mockCreateTab.mockReturnValue({ id: 'tab-1' })
  mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
})

export {
  LEAF_ID,
  mockCreateTab,
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  mockPasteDraftWhenAgentReady,
  mockSeedNativeChatLaunchDraft,
  mockSeedNativeChatLaunchPrompt,
  mockSetActiveTabType,
  mockSetAgentStatus,
  mockSetTabViewMode,
  mockToastError,
  mockToastMessage,
  mockTrack,
  queuedStartups,
  store
}
