// Coverage for the repo-scoped agent-session-rules gap in the tab-bar launch
// path: `startupPlanBase` must thread the launch worktree's repo into rules
// resolution, matching the wiring `launch-work-item-direct.ts` already has.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null,
    agentSessionRules: { enabled: false, rules: [] as unknown[] }
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    agentSessionRules?: { enabled: boolean; rules: unknown[] }
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [
    {
      id: 'repo-1',
      connectionId: null as string | null,
      path: '/repo',
      agentSessionRules: undefined as
        | {
            enabled?: boolean
            extraRules?: {
              id: string
              label: string
              content: string
              enabled: boolean
              source: 'custom'
            }[]
          }
        | undefined
    }
  ],
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
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
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<string, unknown>,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
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
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab agent-session-rules threading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings.agentSessionRules = { enabled: false, rules: [] }
    store.repos = [
      { id: 'repo-1', connectionId: null, path: '/repo', agentSessionRules: undefined }
    ]
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('threads the launch worktree repo into agent-session-rules resolution', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        path: '/repo',
        agentSessionRules: {
          enabled: true,
          extraRules: [
            {
              id: 'custom-repo-rule',
              label: 'Repo rule',
              content: 'REPO ONLY RULE TEXT',
              enabled: true,
              source: 'custom'
            }
          ]
        }
      }
    ]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    await launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1', promptDelivery: 'draft' })

    // Why: claude injects session rules natively via --append-system-prompt on
    // an empty-prompt launch, so a correctly-threaded repoId surfaces here
    // rather than in a post-ready paste.
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ command: expect.stringContaining('REPO ONLY RULE TEXT') })
    )
  })

  it('omits repo-only rules when no rules apply', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    await launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1', promptDelivery: 'draft' })

    const queued = mockQueueTabStartupCommand.mock.calls.at(-1)?.[1] as
      | { command: string }
      | undefined
    expect(queued?.command).not.toContain('REPO ONLY RULE TEXT')
  })
})
