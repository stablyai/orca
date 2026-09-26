import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import { copyLaunchConfig } from '@/store/slices/agent-status-sleeping-records'

type CreateTabOptions = { pendingStartup?: { launchConfig?: SleepingAgentLaunchConfig } }
const mockCreateTab = vi.fn(
  (_worktreeId: string, _a?: unknown, _b?: unknown, _options?: CreateTabOptions) => ({
    id: 'tab-2'
  })
)

const store = {
  settings: { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} },
  repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/feature', displayName: 'feature' }]
  },
  getKnownWorktreeById: (id: string) =>
    store.worktreesByRepo['repo-1'].find((worktree) => worktree.id === id),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
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

function sleptRecord(claudeAccountId: string): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1::leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    prompt: 'finish the task',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    // Sleeping copies the live pane's launch config into the record.
    launchConfig: copyLaunchConfig({ agentArgs: '', agentEnv: {}, claudeAccountId })
  }
}

async function resumedLaunchConfig(
  record: SleepingAgentSessionRecord
): Promise<SleepingAgentLaunchConfig | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  expect(launchSleepingAgentSession(record)).toBe(true)
  return mockCreateTab.mock.calls.at(-1)?.[3]?.pendingStartup?.launchConfig
}

describe('sleep then resume keeps the Claude account the launch ran on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replays a pinned account into the resumed spawn launch config', async () => {
    expect((await resumedLaunchConfig(sleptRecord('acct-b')))?.claudeAccountId).toBe('acct-b')
  })

  it('replays the active-account sentinel so resume does not re-pin to the project default', async () => {
    expect((await resumedLaunchConfig(sleptRecord(ACTIVE_CLAUDE_ACCOUNT)))?.claudeAccountId).toBe(
      ACTIVE_CLAUDE_ACCOUNT
    )
  })
})
