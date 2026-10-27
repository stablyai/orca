import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type * as TuiAgentStartupModule from '@/lib/tui-agent-startup'

const mocks = vi.hoisted(() => {
  const mutable: { clientPlatform: NodeJS.Platform; store: Record<string, unknown> } = {
    clientPlatform: 'win32',
    store: {}
  }
  return {
    ...mutable,
    toastError: vi.fn(),
    createWorktree: vi.fn(),
    activateAndRevealWorktree: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))
vi.mock('@/lib/launch-work-item-direct-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDirectSetupDecision: vi.fn().mockResolvedValue({ kind: 'resolved', decision: 'inherit' })
}))
vi.mock('@/lib/agent-detection-target-inventory', () => ({
  loadProjectLaunchContext: vi.fn().mockResolvedValue(undefined),
  ensureDetectedAgentsForRepo: vi.fn().mockResolvedValue(['claude']),
  ensureDetectedAgentsForNewWorktree: vi.fn().mockResolvedValue(['claude'])
}))
vi.mock('@/lib/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  awaitStructuredRouteHostAnswer: vi.fn().mockResolvedValue(undefined),
  planAgentSessionLaunch: vi.fn(() => ({
    route: 'terminal-tui',
    agent: 'claude',
    requestId: 'test-request'
  }))
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: (a: string) => a }))
vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get CLIENT_PLATFORM() {
    return mocks.clientPlatform
  }
}))
vi.mock('@/lib/tui-agent-startup', async () => {
  const actual = await vi.importActual<typeof TuiAgentStartupModule>('@/lib/tui-agent-startup')
  return { ...actual, buildAgentDraftLaunchPlan: vi.fn(actual.buildAgentDraftLaunchPlan) }
})

import { launchWorkItemDirect } from './launch-work-item-direct'
import { buildAgentDraftLaunchPlan } from '@/lib/tui-agent-startup'

function runtimeStatus(hostPlatform?: NodeJS.Platform): RuntimeEnvironmentStatus {
  return {
    checkedAt: 1,
    status: {
      runtimeId: 'rt',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      ...(hostPlatform ? { hostPlatform } : {})
    }
  }
}

function sshState(remotePlatform: 'linux' | 'win32'): SshConnectionState {
  return { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0, remotePlatform }
}

type HostCase = {
  name: string
  client: NodeJS.Platform
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
  ssh?: Map<string, SshConnectionState>
  runtime?: Map<string, RuntimeEnvironmentStatus>
  expected: NodeJS.Platform
}

function setStore(hostCase: HostCase): void {
  mocks.clientPlatform = hostCase.client
  const repos: Repo[] = [
    { id: 'repo-1', displayName: 'Repo', badgeColor: '#000000', addedAt: 1, ...hostCase.repo }
  ]
  mocks.store = {
    repos,
    activeRepoId: null,
    activeWorktreeId: null,
    endpointProjects: [],
    endpointProjectHostSetups: [],
    projectGroups: [],
    folderWorkspaces: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [], agentCmdOverrides: {} },
    sshConnectionStates: hostCase.ssh ?? new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: hostCase.runtime ?? new Map(),
    createWorktree: mocks.createWorktree,
    updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
    setSidebarOpen: vi.fn()
  }
}

function startLinearIssue(): Promise<boolean> {
  return launchWorkItemDirect({
    repoId: 'repo-1',
    launchSource: 'task_page',
    openModalFallback: vi.fn(),
    agentOverride: 'claude',
    item: {
      type: 'issue',
      number: null,
      title: 'Ship it',
      url: 'https://linear.app/acme/issue/ENG-1/ship-it',
      linearIdentifier: 'ENG-1'
    }
  })
}

const HOST_CASES: HostCase[] = [
  {
    name: 'Windows client -> paired Linux Orca server',
    client: 'win32',
    repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
    runtime: new Map([['linux-box', runtimeStatus('linux')]]),
    expected: 'linux'
  },
  {
    name: 'Windows client -> Linux SSH host',
    client: 'win32',
    repo: { path: '/home/alice/repo', connectionId: 'box' },
    ssh: new Map([['box', sshState('linux')]]),
    expected: 'linux'
  },
  {
    name: 'Linux client -> paired Windows Orca server',
    client: 'linux',
    repo: { path: 'D:\\repo', executionHostId: 'runtime:win-box' },
    runtime: new Map([['win-box', runtimeStatus('win32')]]),
    expected: 'win32'
  },
  {
    name: 'macOS client -> Windows SSH host',
    client: 'darwin',
    repo: { path: 'C:\\Users\\alice\\repo', connectionId: 'box' },
    ssh: new Map([['box', sshState('win32')]]),
    expected: 'win32'
  },
  {
    name: 'Linux client -> paired Linux Orca server',
    client: 'linux',
    repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
    runtime: new Map([['linux-box', runtimeStatus('linux')]]),
    expected: 'linux'
  },
  {
    name: 'Windows client -> paired Windows Orca server',
    client: 'win32',
    repo: { path: 'D:\\repo', executionHostId: 'runtime:win-box' },
    runtime: new Map([['win-box', runtimeStatus('win32')]]),
    expected: 'win32'
  },
  { name: 'local Linux', client: 'linux', repo: { path: '/repo' }, expected: 'linux' },
  { name: 'local Windows', client: 'win32', repo: { path: 'C:\\repo' }, expected: 'win32' }
]

describe('launchWorkItemDirect quotes for the execution host (#27971)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/wt', path: '/wt' },
      setup: undefined
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
  })

  it.each(HOST_CASES)('$name', async (hostCase) => {
    setStore(hostCase)

    await expect(startLinearIssue()).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: hostCase.expected })
    )
    const command: string = mocks.activateAndRevealWorktree.mock.calls[0]?.[1]?.startup?.command
    expect(command).toContain('Linked Linear issue: ENG-1')
    if (hostCase.expected === 'win32') {
      expect(command).toContain('`n')
    } else {
      // Why: a PowerShell "`n" draft leaves bash waiting at its continuation prompt.
      expect(command).not.toContain('`n')
    }
  })

  it("keeps the server's OS when the created worktree is not hydrated yet", async () => {
    setStore(HOST_CASES[0])
    mocks.createWorktree.mockResolvedValue({ worktree: { id: 'wt-new', path: '/wt' } })

    await expect(startLinearIssue()).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'linux' })
    )
  })

  it("quotes a Windows server's new WSL worktree for that distro", async () => {
    setStore(HOST_CASES[5])
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\wt' }
    })

    await expect(startLinearIssue()).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'linux' })
    )
  })

  it("quotes a local Windows project's WSL runtime for that distro", async () => {
    setStore({ name: 'wsl', client: 'win32', repo: { path: 'C:\\repo' }, expected: 'linux' })
    mocks.store.endpointProjectHostSetups = [
      {
        id: 'repo-1',
        projectId: 'repo-1',
        repoId: 'repo-1',
        path: 'C:\\repo',
        displayName: 'Repo',
        hostId: 'local',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 1,
        updatedAt: 1
      }
    ] satisfies ProjectHostSetup[]
    mocks.store.endpointProjects = [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ] satisfies Project[]
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::C:\\repo-wt', path: 'C:\\repo-wt' }
    })

    await expect(startLinearIssue()).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'linux' })
    )
  })

  it("applies this client's Windows shell only to a local launch", async () => {
    setStore({ name: 'local', client: 'win32', repo: { path: 'C:\\repo' }, expected: 'win32' })
    mocks.store.settings = {
      defaultTuiAgent: 'claude',
      agentCmdOverrides: {},
      terminalWindowsShell: 'cmd.exe'
    }

    await expect(startLinearIssue()).resolves.toBe(true)

    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'win32', shell: 'cmd' })
    )
  })

  it('stops before creating a workspace when the server has not reported its OS', async () => {
    setStore({
      name: 'unreported',
      client: 'win32',
      repo: { path: '/srv/repo', executionHostId: 'runtime:linux-box' },
      runtime: new Map([['linux-box', runtimeStatus()]]),
      expected: 'linux'
    })

    await expect(startLinearIssue()).resolves.toBe(false)

    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'This Orca server does not report its operating system. Update the server to launch agents on it.'
    )
  })
})
