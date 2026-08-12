// Coverage for the repo-scoped agent-session-rules gap in the sleeping-agent
// resume path: a resumed session must thread the worktree's repo into rules
// resolution and forward the computed draftPrompt into the queued tab.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()

const store = {
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
    terminalWindowsShell?: string
    agentSessionRules?: { enabled: boolean; rules: unknown[] }
  },
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
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/feature', displayName: 'feature' }]
  } as Record<string, { id: string; repoId: string; path: string; displayName: string }[]>,
  getKnownWorktreeById: (id: string) =>
    Object.values(store.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === id),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  queueTabStartupCommand: mockQueueTabStartupCommand,
  claimAutomaticAgentResume: vi.fn(),
  clearSleepingAgentSession: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn((_stored, termIds: string[]) => [...termIds])
}))

const SESSION_ID = '0199f7a1-0000-7000-8000-000000000002'

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1::leaf-1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  // Why: opencode has no native session-rules mechanism (no sessionRulesTextFlag/
  // sessionRulesConfigOverride), unlike claude/codex, so this exercises the
  // draftPrompt fallback path specifically rather than command-line embedding.
  agent: 'opencode',
  providerSession: { key: 'session_id', id: SESSION_ID },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}

describe('launchSleepingAgentSession agent-session-rules threading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      agentSessionRules: { enabled: false, rules: [] }
    }
    store.repos = [
      { id: 'repo-1', connectionId: null, path: '/repo', agentSessionRules: undefined }
    ]
    store.worktreesByRepo = {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/feature', displayName: 'feature' }]
    }
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('carries the resumed worktree repo into the queued draftPrompt', async () => {
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
              content: 'RESUME REPO ONLY RULE TEXT',
              enabled: true,
              source: 'custom'
            }
          ]
        }
      }
    ]
    const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')

    launchSleepingAgentSession(record)

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        draftPrompt: expect.stringContaining('RESUME REPO ONLY RULE TEXT')
      })
    )
  })

  it('omits draftPrompt when no agent-session-rules apply', async () => {
    const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')

    launchSleepingAgentSession(record)

    const queued = mockQueueTabStartupCommand.mock.calls.at(-1)?.[1] as
      | { draftPrompt?: string }
      | undefined
    expect(queued?.draftPrompt).toBeUndefined()
  })
})
