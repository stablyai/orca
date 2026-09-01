// Windows shell coverage for the sleeping-agent resume launch (#12320).
//
// Resume is now an identity-only host launch: the renderer queues an empty
// command plus the session ownership key, and the host resolves the argv and
// quotes it for the shell IT will spawn (pty.ts routes `agentLaunch.resume`
// through resolveResumeLaunchIngest, which derives the shell from the host's
// own terminalWindowsShell via deriveAgentLaunchHostState). The hazard this
// file guards therefore inverts: instead of asserting the renderer picks the
// right quoting, it asserts the renderer emits NO shell-shaped text at all, so
// a cmd.exe tab can never receive PowerShell quoting and the client's local
// Windows shell setting can never shape an SSH workspace's resume line.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()

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
  queueTabStartupCommand: mockQueueTabStartupCommand,
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

type QueuedResumeStartup = {
  command: string
  agentLaunch?: { resume?: { operation: string; sessionKey: Record<string, unknown> } }
}

async function launch(): Promise<QueuedResumeStartup | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(record)
  return mockQueueTabStartupCommand.mock.calls.at(-1)?.[1] as QueuedResumeStartup | undefined
}

const IDENTITY_ONLY_RESUME = {
  command: '',
  agentLaunch: {
    resume: {
      operation: 'resume',
      sessionKey: { worktreeId: 'wt-1', baseAgent: 'codex', providerSessionId: SESSION_ID }
    }
  }
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

  it.each(['cmd.exe', 'powershell.exe', 'git-bash'])(
    'emits no client-quoted argv for a %s tab',
    async (windowsShell) => {
      store.settings.terminalWindowsShell = windowsShell

      const queued = await launch()

      expect(queued).toMatchObject(IDENTITY_ONLY_RESUME)
      // The failure this guards: any shell-shaped resume line reaching a tab
      // whose shell the renderer only guessed.
      expect(queued?.command).toBe('')
    }
  )

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

    await expect(launch()).resolves.toMatchObject(IDENTITY_ONLY_RESUME)
  })
})
