// Windows shell-quoting coverage for the sleeping-agent resume launch (#12320):
// the queued resume line is typed into the new tab's shell, so cmd.exe tabs must
// not receive PowerShell single quotes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    terminalWindowsShell?: string
  },
  repos: [
    {
      id: 'repo-1',
      connectionId: null as string | null,
      path: 'C:\\Users\\neil\\repo'
    }
  ],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\Users\\neil\\repo\\feature',
        displayName: 'feature'
      }
    ]
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
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
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
  agent: 'codex',
  providerSession: { key: 'session_id', id: SESSION_ID },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}

async function launch(): Promise<string | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(record)
  const options = mockCreateTab.mock.calls.at(-1)?.[3] as
    | { pendingStartup?: { command: string } }
    | undefined
  return options?.pendingStartup?.command
}

describe('launchSleepingAgentSession Windows shell quoting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    store.repos = [{ id: 'repo-1', connectionId: null, path: 'C:\\Users\\neil\\repo' }]
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: 'C:\\Users\\neil\\repo\\feature',
          displayName: 'feature'
        }
      ]
    }
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('quotes the resume argv for a cmd.exe tab', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'

    await expect(launch()).resolves.toBe(
      `codex "--dangerously-bypass-approvals-and-sandbox" "resume" "${SESSION_ID}"`
    )
  })

  it('keeps PowerShell quoting for a powershell tab', async () => {
    store.settings.terminalWindowsShell = 'powershell.exe'

    await expect(launch()).resolves.toBe(
      `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`
    )
  })

  it('quotes the resume argv for a Git Bash tab', async () => {
    store.settings.terminalWindowsShell = 'git-bash'

    await expect(launch()).resolves.toBe(
      `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`
    )
  })

  it('ignores the local Windows shell setting for an SSH workspace', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/home/neil/repo' }]
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/home/neil/repo/feature',
          displayName: 'feature'
        }
      ]
    }

    await expect(launch()).resolves.toBe(
      `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`
    )
  })
})
