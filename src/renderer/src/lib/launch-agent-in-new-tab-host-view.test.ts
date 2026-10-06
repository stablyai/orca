import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn()
}))

type StoreSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
}

function settings(openAgentTabsInChatByDefault: boolean): StoreSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: 'web-runtime',
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault
  }
}

const tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]> = {
  'wt-1': [{ id: 'tab-1' }]
}
const openFiles: { id: string; worktreeId: string }[] = []
const browserTabsByWorktree: Record<string, { id: string }[]> = {}
const tabBarOrderByWorktree: Record<string, string[]> = {}
const runtimeStatusByEnvironmentId = new Map<string, { status: { capabilities: string[] } }>()

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: settings(false),
  runtimeStatusByEnvironmentId,
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
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
  tabsByWorktree,
  openFiles,
  browserTabsByWorktree,
  tabBarOrderByWorktree,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: vi.fn(() => true),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))
import { AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

describe('paired "+" to a host that stamps launch views', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeStatusByEnvironmentId.set('web-runtime', {
      status: { capabilities: [AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY] }
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
  })
  for (const chat of [false, true]) {
    it(`default ${chat ? 'chat' : 'terminal'}: sends launcherDefaultView only`, async () => {
      store.settings = settings(chat)
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      launchAgentInNewTab({ requestId: `r-${chat}`, agent: 'claude', worktreeId: 'wt-1' })
      const sent = mocks.createWebRuntimeSessionTerminal.mock.calls[0]?.[0]
      expect(sent).toMatchObject({ launcherDefaultView: chat ? 'chat' : 'terminal' })
      expect(sent).not.toHaveProperty('viewMode')
    })
  }
  it('unmirrorable draft: pins terminal', async () => {
    store.settings = settings(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    launchAgentInNewTab({
      requestId: 'r-d',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'a b',
      promptDelivery: 'draft'
    })
    const sent = mocks.createWebRuntimeSessionTerminal.mock.calls[0]?.[0]
    expect(sent).toMatchObject({ viewMode: 'terminal', launcherDefaultView: 'chat' })
  })
})
