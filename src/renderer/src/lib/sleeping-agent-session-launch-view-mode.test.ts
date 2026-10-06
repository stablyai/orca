// Ported from community PR #19704 (Minhoi Goo): Agent Sleep's wake opens a fresh tab for a
// hibernated session (#19668), so the record's saved view must reach that tab.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()

type KnownWorktree = { id: string; repoId: string; path: string; displayName: string }
const worktreesByRepo: Record<string, KnownWorktree[]> = {
  'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/feature', displayName: 'feature' }]
}
const noRuntime: string | null = null
const noConnection: string | null = null
const noArgs: Record<string, string> = {}
const noEnv: Record<string, Record<string, string>> = {}
const noOrder: Record<string, string[]> = {}
const noFiles: { id: string; worktreeId: string }[] = []
const noBrowserTabs: Record<string, { id: string }[]> = {}

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: noArgs,
    agentDefaultEnv: noEnv,
    activeRuntimeEnvironmentId: noRuntime,
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true
  },
  repos: [{ id: 'repo-1', connectionId: noConnection, path: '/repo' }],
  worktreesByRepo,
  getKnownWorktreeById: (id: string) =>
    Object.values(store.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === id),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: noFiles,
  browserTabsByWorktree: noBrowserTabs,
  tabBarOrderByWorktree: noOrder,
  createTab: mockCreateTab,
  claimAutomaticAgentResume: vi.fn(),
  clearSleepingAgentSession: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
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
  return mockCreateTab.mock.calls.at(-1)?.[3]
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

  it('resumes a terminal record into terminal even when the default is now chat', async () => {
    const options = await launchAndGetCreateTabOptions(record({ viewMode: 'terminal' }))
    expect(options?.viewMode).toBe('terminal')
  })

  it('does not set viewMode for a legacy record, never applying the current default', async () => {
    const options = await launchAndGetCreateTabOptions(record())
    expect(options?.viewMode).toBeUndefined()
  })
})
