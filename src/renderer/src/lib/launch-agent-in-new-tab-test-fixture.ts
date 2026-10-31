import { settleAgentLaunchPaneStart } from './agent-launch-pane-start'
import { beforeEach, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { AppState } from '@/store/types'
import type { pasteDraftWhenAgentReady } from './agent-paste-draft'
import type { waitForAgentReady } from './agent-ready-wait'
import type { track } from './telemetry'
import type { toast } from 'sonner'
import type {
  createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft
} from '@/runtime/web-runtime-terminal-creation'
import type { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import type { Project } from '../../../shared/project-types'

export const mockCreateTab = vi.fn<(...args: Parameters<AppState['createTab']>) => { id: string }>()
export function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
export const mockSetActiveTabType = vi.fn<AppState['setActiveTabType']>()
export const mockSetTabViewMode = vi.fn<AppState['setTabViewMode']>()
export const mockSetTabBarOrder = vi.fn<AppState['setTabBarOrder']>()
export const mockSetAgentStatus = vi.fn<AppState['setAgentStatus']>()
export const mockPasteDraftWhenAgentReady = vi.fn<typeof pasteDraftWhenAgentReady>()
export const mockSeedNativeChatLaunchPrompt = vi.fn<AppState['seedNativeChatLaunchPrompt']>()
export const mockSeedNativeChatLaunchDraft = vi.fn<AppState['seedNativeChatLaunchDraft']>()
export const mockMarkNativeChatLaunchPromptFailed =
  vi.fn<AppState['markNativeChatLaunchPromptFailed']>()
export const mockTrack = vi.fn<typeof track>()
export const mockToastMessage = vi.fn<typeof toast.message>()
export const mockWaitForAgentReady = vi.fn<typeof waitForAgentReady>()

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const initialProjects: Pick<Project, 'id' | 'localWindowsRuntimePreference'>[] = [
  { id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }
]

const settings: {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  terminalWindowsShell?: string
  agentDefaultSurface?: 'chat' | 'terminal'
  nativeChatProviders?: Record<string, boolean>
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

export const store = {
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
  allWorktrees: vi.fn<
    () => { id: string; repoId: string; projectId: string; path: string; displayName: string }[]
  >(() => store.worktreesByRepo['repo-1']),
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
  closeTab: vi.fn<AppState['closeTab']>(),
  setActiveTabType: mockSetActiveTabType,
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  seedNativeChatLaunchDraft: mockSeedNativeChatLaunchDraft,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'tab-1' }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => false,
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

export const mockToastError = vi.fn<typeof toast.error>()

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

export const mockCreateWebRuntimeSessionTerminal = vi.fn<typeof createWebRuntimeSessionTerminal>()
export const mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft =
  vi.fn<typeof createWebRuntimeAgentSessionTerminalWithLaunchDraft>()
export const mockIsWebRuntimeSessionActive = vi.fn<typeof isWebRuntimeSessionActive>(() => false)

vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: async (
    args: Parameters<typeof createWebRuntimeSessionTerminal>[0]
  ) => ({
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

export const COMMAND_CODE_CLICK = {
  requestId: 'command-code-click',
  agent: 'command-code',
  worktreeId: 'wt-1'
} as const

beforeEach(() => {
  vi.clearAllMocks()
  setLocalRuntimeCapabilitiesForTests([])
  mockIsWebRuntimeSessionActive.mockReturnValue(false)
  mockCreateWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({
    outcome: { status: 'created' },
    promptDelivered: true
  })
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
  mockCreateTab.mockImplementation((_worktreeId, _groupId, _unused, options) => {
    const tab = { id: options?.id ?? 'tab-1' }
    store.tabsByWorktree['wt-1'].push(tab)
    const leafId = options?.initialLeafId
    if (options?.pendingStartup?.agentLaunch && leafId) {
      queueMicrotask(() => settleAgentLaunchPaneStart(tab.id, leafId, 'pty-1'))
    }
    return tab
  })
  mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
})
