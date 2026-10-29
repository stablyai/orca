// Resume lines enter the selected Windows shell; cmd.exe must never receive PowerShell single quoting (#12320).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type * as ConnectionOwnerResolution from '@/lib/connection-owner-resolution'

const mockCreateTab = vi.fn()

type TestRepo = { id: string; connectionId: string | null; executionHostId?: string; path: string }
const INITIAL_REPOS: TestRepo[] = [
  { id: 'repo-1', connectionId: null, path: 'C:\\Users\\neil\\repo' }
]

const store = {
  agentStatusByPaneKey: {},
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
  repos: INITIAL_REPOS,
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
  sshConnectionStates: new Map<string, { remotePlatform?: NodeJS.Platform }>(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map<string, { status: { hostPlatform: NodeJS.Platform } }>(),
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
const connectionOwner = vi.hoisted((): { nestedConnectionId: string | undefined } => ({
  nestedConnectionId: undefined
}))
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionOwnerResolution>()
  return {
    ...actual,
    getConnectionIdFromState: (...args: Parameters<typeof actual.getConnectionIdFromState>) =>
      connectionOwner.nestedConnectionId ?? actual.getConnectionIdFromState(...args)
  }
})
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

async function launch(sessionRecord = record): Promise<string | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(sessionRecord)
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
    store.sshConnectionStates = new Map()
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
    store.runtimeStatusByEnvironmentId = new Map()
    connectionOwner.nestedConnectionId = undefined
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  // Why: a folder or nested-SSH workspace on a server runs on its SSH target, so the server's OS must not quote it.
  it('quotes a nested SSH workspace on a Windows server for its SSH target', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        executionHostId: 'runtime:env-1',
        path: '/home/neil/repo'
      }
    ]
    store.worktreesByRepo = {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/home/neil/repo', displayName: 'feature' }]
    }
    store.runtimeStatusByEnvironmentId = new Map([['env-1', { status: { hostPlatform: 'win32' } }]])
    connectionOwner.nestedConnectionId = 'ssh-nested'

    await expect(
      launch({ ...record, providerSession: { key: 'session_id', id: "s'1" } })
    ).resolves.toContain(`'resume' 's'"'"'1'`)
  })

  it('quotes the resume argv for a cmd.exe tab', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'

    await expect(launch()).resolves.toBe(`codex "resume" "${SESSION_ID}"`)
  })

  it('keeps PowerShell quoting for a powershell tab', async () => {
    store.settings.terminalWindowsShell = 'powershell.exe'

    await expect(launch()).resolves.toBe(`codex 'resume' '${SESSION_ID}'`)
  })

  it('quotes the resume argv for a Git Bash tab', async () => {
    store.settings.terminalWindowsShell = 'git-bash'

    await expect(launch()).resolves.toBe(`codex 'resume' '${SESSION_ID}'`)
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

    await expect(launch()).resolves.toBe(`codex 'resume' '${SESSION_ID}'`)
  })
  it.each([
    ['cmd.exe', 'omp "--resume" "C:\\custom sessions\\session.jsonl"'],
    ['powershell.exe', "omp '--resume' 'C:\\custom sessions\\session.jsonl'"]
  ])('keeps a hook-only OMP locator when waking into %s', async (shell, expected) => {
    store.settings.terminalWindowsShell = shell
    const omp: SleepingAgentSessionRecord = {
      ...record,
      agent: 'omp',
      providerSession: {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: 'C:\\custom sessions\\session.jsonl'
      }
    }
    await expect(launch(omp)).resolves.toBe(expected)
  })
  it('quotes for PowerShell on an SSH host that reported Windows', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: 'C:\\repo' }]
    store.sshConnectionStates = new Map([['ssh-1', { remotePlatform: 'win32' }]])
    const omp: SleepingAgentSessionRecord = {
      ...record,
      agent: 'omp',
      providerSession: {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: "C:\\neil's sessions\\session.jsonl"
      }
    }
    await expect(launch(omp)).resolves.toBe("omp '--resume' 'C:\\neil''s sessions\\session.jsonl'")
  })
  it('keeps the remote OMP path instead of using the local Windows shell or UUID', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-1', path: '/repo' }]
    const omp: SleepingAgentSessionRecord = {
      ...record,
      agent: 'omp',
      providerSession: {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: '/remote/custom sessions/session.jsonl'
      }
    }
    await expect(launch(omp)).resolves.toBe(
      "omp '--resume' '/remote/custom sessions/session.jsonl'"
    )
  })
})
