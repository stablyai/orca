// Permission coverage for the sleeping-agent resume launch (#10886): the recorded
// launch config is the pane's original launch, so an escalation the user has since
// turned off must not ride along into the resume.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/home/dev/repo' }],
  worktreesByRepo: {
    'repo-1': [
      { id: 'wt-1', repoId: 'repo-1', path: '/home/dev/repo/feature', displayName: 'feature' }
    ]
  },
  getKnownWorktreeById: (id: string) =>
    Object.values(store.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === id),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: mockCreateTab,
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

const SESSION_ID = '0199f7a1-0000-7000-8000-000000000001'

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1::leaf-1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: SESSION_ID },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1,
  launchConfig: {
    agentCommand: "claude '--dangerously-skip-permissions'",
    agentArgs: '--dangerously-skip-permissions',
    agentEnv: {}
  }
}

async function launch(): Promise<{ command: string; agentArgsOverride?: string } | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(record)
  const options = mockCreateTab.mock.calls.at(-1)?.[3] as
    | { pendingStartup?: { command: string; agentArgsOverride?: string } }
    | undefined
  return options?.pendingStartup
}

describe('launchSleepingAgentSession permission escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('resumes without the escalation once the setting no longer grants it', async () => {
    store.settings.agentDefaultArgs = { claude: '' }

    await expect(launch()).resolves.toMatchObject({
      command: `claude '--resume' '${SESSION_ID}'`,
      agentArgsOverride: ''
    })
  })

  it('keeps the escalation while the setting still grants it', async () => {
    store.settings.agentDefaultArgs = { claude: '--dangerously-skip-permissions' }

    await expect(launch()).resolves.toMatchObject({
      command: `claude '--dangerously-skip-permissions' '--resume' '${SESSION_ID}'`,
      agentArgsOverride: '--dangerously-skip-permissions'
    })
  })
})
