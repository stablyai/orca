// Agent Sleep's restart opens a fresh tab for a hibernated session (#19668):
// a record captured from a tab in native chat view must resume into a tab
// with viewMode: 'chat', or mobile clients render it as a plain terminal.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
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

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1::leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: SESSION_ID },
    prompt: 'finish the task',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

async function launchAndGetCreateTabOptions(
  input: SleepingAgentSessionRecord
): Promise<{ viewMode?: 'terminal' | 'chat' } | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(input)
  return mockCreateTab.mock.calls.at(-1)?.[3] as { viewMode?: 'terminal' | 'chat' } | undefined
}

describe('launchSleepingAgentSession viewMode passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('resumes a chat-viewMode record into a chat-viewMode tab', async () => {
    const options = await launchAndGetCreateTabOptions(record({ viewMode: 'chat' }))
    expect(options?.viewMode).toBe('chat')
  })

  it('does not set viewMode for a plain terminal record', async () => {
    const options = await launchAndGetCreateTabOptions(record())
    expect(options?.viewMode).toBeUndefined()
  })
})
