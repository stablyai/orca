// Layout-owner build: the sidebar's resume of a sleeping agent opens a new tab whose start main's
// create cannot carry yet (L252), so the window spawns it and its pane seeds the "session
// restored" banner from the tab's startup, as with the switch off.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { startupNeedsWindowSpawn } from '@/store/terminals/window-tab-start-in-main'
import { seedStartupSessionRestoredBanner } from '@/components/terminal-pane/session-restored-banner-pane-state'
import type { AppState } from '@/store/types'

type TabStartup = AppState['pendingStartupByTabId'][string]

const mockCreateTab = vi.fn((..._args: unknown[]) => ({ id: 'tab-1' }))

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} },
      repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
      getKnownWorktreeById: () => ({ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      runtimeStatusByEnvironmentId: new Map(),
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      openFiles: [],
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: {},
      createTab: mockCreateTab,
      claimAutomaticAgentResume: vi.fn(),
      clearSleepingAgentSession: vi.fn(),
      setActiveTabType: vi.fn(),
      setTabBarOrder: vi.fn()
    })
  }
}))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn((_stored, termIds: string[]) => [...termIds])
}))

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-0:leaf-0',
  tabId: 'tab-0',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'claude-session-1' },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}

async function sidebarResumeStartup(): Promise<TabStartup | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  expect(launchSleepingAgentSession(record)).toBe(true)
  const options: unknown = mockCreateTab.mock.calls.at(-1)?.[3]
  return typeof options === 'object' && options !== null && 'pendingStartup' in options
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createTab's fourth argument carries the tab's pending startup.
      (options.pendingStartup as TabStartup)
    : undefined
}

describe("the sidebar's resume of a sleeping agent (layout-owner build)", () => {
  beforeEach(() => {
    mockCreateTab.mockClear()
  })

  it('keeps the window spawn, whose pane shows the session restored banner', async () => {
    const startup = await sidebarResumeStartup()

    expect(startup).toMatchObject({ resumeProviderSession: record.providerSession })
    // Main's create cannot carry this start yet, so the window spawns it (L252).
    expect(startupNeedsWindowSpawn(startup)).toBe(true)
    const onShow = vi.fn()
    seedStartupSessionRestoredBanner(startup, 7, onShow)
    expect(onShow).toHaveBeenCalledExactlyOnceWith(7)
  })
})
