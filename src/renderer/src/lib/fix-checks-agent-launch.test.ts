import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../shared/tui-agent-startup'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import { getDefaultSettings } from '../../../shared/constants'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch-settings'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecutionHostFactsModule from '@/lib/execution-host-facts'
import type * as HostChatProgramAcquisitionModule from './host-chat-program-acquisition'

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
afterEach(clearHostAgentMenuSettingsForTests)

const mocks = vi.hoisted(() => {
  const store = {
    settings: { defaultTuiAgent: 'codex' },
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null as string | null
      }
    ],
    worktrees: [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/wt-1'
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/wt-1'
        }
      ]
    },
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Record<string, unknown>[],
    allWorktrees: vi.fn(() => store.worktrees),
    ensureDetectedAgents: vi.fn(),
    ensureRemoteDetectedAgents: vi.fn()
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(),
    findGithubPrWorkspaceAttachment: vi.fn(),
    focusTerminalTabSurface: vi.fn(),
    getConnectionId: vi.fn(),
    launchAgentInNewTab: vi.fn(),
    launchWorkItemDirect: vi.fn(),
    pickSourceControlLaunchAgent: vi.fn(),
    readSourceControlLaunchRecipeAgentId: vi.fn(),
    resolveSourceControlActionRecipe: vi.fn(),
    resolveRepoWorktreeLaunchPlatform: vi.fn(),
    toastError: vi.fn(),
    toastMessage: vi.fn()
  }
})

vi.mock('./host-chat-program-acquisition', async (importOriginal) => ({
  ...(await importOriginal<typeof HostChatProgramAcquisitionModule>()),
  acquireAgentLaunchChoices: async (_: unknown, run: () => unknown) => ({ detected: await run() })
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: mocks.toastMessage
  }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/github-work-item-workspace-attachment', () => ({
  findGithubPrWorkspaceAttachment: mocks.findGithubPrWorkspaceAttachment
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/launch-work-item-direct', () => ({
  launchWorkItemDirect: mocks.launchWorkItemDirect
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('../../../shared/source-control-launch-agent-selection', () => ({
  pickSourceControlLaunchAgent: mocks.pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId: mocks.readSourceControlLaunchRecipeAgentId
}))

vi.mock('@/lib/execution-host-facts', async () => {
  const actual = await vi.importActual<typeof ExecutionHostFactsModule>(
    '@/lib/execution-host-facts'
  )
  return {
    ...actual,
    resolveRepoWorktreeLaunchPlatform: mocks.resolveRepoWorktreeLaunchPlatform
  }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('../../../shared/source-control-ai', () => ({
  resolveSourceControlActionRecipe: mocks.resolveSourceControlActionRecipe
}))

describe('startFixChecksAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.settings = { defaultTuiAgent: 'codex' }
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null
      }
    ]
    mocks.store.worktrees = [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }]
    mocks.store.worktreesByRepo = { 'repo-1': mocks.store.worktrees }
    mocks.store.projects = [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    mocks.store.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.store.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    mocks.findGithubPrWorkspaceAttachment.mockReturnValue(null)
    mocks.getConnectionId.mockReturnValue(null)
    mocks.launchAgentInNewTab.mockImplementation(
      (args: { beforeSurfaceOpen?: (surface: { kind: 'local-terminal' }) => boolean | void }) => {
        args.beforeSurfaceOpen?.({ kind: 'local-terminal' })
        return { surface: { kind: 'local-terminal', tabId: 'tab-1' } }
      }
    )
    mocks.launchWorkItemDirect.mockResolvedValue(true)
    mocks.pickSourceControlLaunchAgent.mockImplementation(({ detectedAgents }) => {
      return detectedAgents.includes('codex') ? 'codex' : null
    })
    mocks.readSourceControlLaunchRecipeAgentId.mockReturnValue(null)
    mocks.resolveSourceControlActionRecipe.mockReturnValue({
      commandInputTemplate: '{basePrompt}'
    })
    mocks.resolveRepoWorktreeLaunchPlatform.mockReturnValue('darwin')
  })

  it('activates the attached workspace as a surface-providing caller', async () => {
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    // The launcher owns creation; activation must not seed a sibling shell after the last terminal closed.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
    })
  })

  it('carries the actual use-default literal from Fix Checks into final startup and its recipe', async () => {
    const settings = {
      ...getDefaultSettings('/test'),
      agentPermissionDefault: 'own' as const,
      defaultTuiAgent: 'claude' as const,
      agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
    }
    Object.assign(mocks.store.settings, settings)
    mocks.store.ensureDetectedAgents.mockResolvedValue(['claude'])
    mocks.pickSourceControlLaunchAgent.mockReturnValue('claude')
    mocks.resolveSourceControlActionRecipe.mockReturnValue({
      agentId: null,
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model literal'
    })
    const plans: ReturnType<typeof buildAgentStartupPlan>[] = []
    mocks.launchAgentInNewTab.mockImplementation((args: LaunchAgentInNewTabArgs) => {
      plans.push(
        buildAgentStartupPlan({
          ...resolveAgentStartupPlanInputs({
            agent: args.agent,
            settings,
            agentArgs: args.agentArgs,
            sessionOptions: args.sessionOptions,
            sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
            platform: 'linux',
            shell: 'posix',
            isRemote: false
          }),
          prompt: '',
          allowEmptyPromptLaunch: true
        })
      )
      return {
        surface: { kind: 'local-terminal', tabId: 'proof' },
        promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
      }
    })
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')
    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.launchCommand).toBe("claude '--model' 'literal'")
    expect(plans[0]?.launchConfig.agentArgs).toBe('--model literal')
    expect(plans[0]?.launchCommand).not.toContain('high')
  })

  it('fails without launching when the requested worktree is missing', async () => {
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'missing-worktree',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('fails without launching when agent detection finds no enabled agent', async () => {
    mocks.store.ensureDetectedAgents.mockResolvedValue([])
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('rejects without launching when remote agent detection fails', async () => {
    mocks.store.repos = [{ ...mocks.store.repos[0], connectionId: 'conn-1' }]
    mocks.getConnectionId.mockReturnValue('conn-1')
    mocks.store.ensureRemoteDetectedAgents.mockRejectedValue(new Error('detection failed'))
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).rejects.toThrow('detection failed')

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it("resolves the attached workspace's own execution host", async () => {
    mocks.store.repos = [
      {
        ...mocks.store.repos[0],
        connectionId: 'ssh-1'
      }
    ]
    mocks.getConnectionId.mockReturnValue(undefined)
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.resolveRepoWorktreeLaunchPlatform).toHaveBeenCalledWith(
      mocks.store,
      expect.objectContaining({ id: 'repo-1', connectionId: 'ssh-1' }),
      expect.objectContaining({ id: 'wt-1', path: '/repo/wt-1' })
    )
  })

  it("plans a Linux server's launch for that server from a Windows client (#27971)", async () => {
    mocks.resolveRepoWorktreeLaunchPlatform.mockReturnValue('linux')
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ launchPlatform: 'linux' })
    )
  })

  it('fails without launching when the execution host has not reported its OS', async () => {
    mocks.resolveRepoWorktreeLaunchPlatform.mockReturnValue(undefined)
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(false)

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('leaves hidden CLI validation to the selected launch route', async () => {
    mocks.resolveSourceControlActionRecipe.mockReturnValue({
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model "unterminated'
    })
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agentArgs: '--model "unterminated' })
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('rejects without focusing a terminal when agent launch throws', async () => {
    mocks.launchAgentInNewTab.mockImplementation(() => {
      throw new Error('launch failed')
    })
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')

    await expect(
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        basePrompt: 'Fix checks',
        launchSource: 'task_page'
      })
    ).rejects.toThrow('launch failed')

    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })

  // Why: a saved chat stays implicit so a host that stops running chats falls back to a terminal.
  it('replays a saved terminal explicitly and leaves a saved chat to the settings route', async () => {
    Object.assign(mocks.store.settings, { disabledTuiAgents: ['codex'] })
    Object.assign(mocks.store, {
      runtimeStatusByEnvironmentId: new Map(),
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['codex'])
    })
    Object.assign(mocks.store.repos[0], { kind: 'folder', executionHostId: 'runtime:alpha' })
    Object.assign(mocks.store.worktrees[0], { hostId: 'runtime:alpha' })
    const preferences = projectAgentLaunchSettings({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude']
    })
    hostRpc.mockResolvedValue({ settings: preferences })
    mocks.readSourceControlLaunchRecipeAgentId.mockReturnValue('codex')
    const { startFixChecksAgent } = await import('./fix-checks-agent-launch')
    const launch = (worktreeId: string | null) =>
      startFixChecksAgent({
        repoId: 'repo-1',
        worktreeId,
        basePrompt: 'Fix checks',
        launchSource: 'task_page',
        item: {
          id: 'pr-7',
          repoId: 'repo-1',
          type: 'pr',
          number: 7,
          title: 'PR',
          state: 'open',
          url: 'https://example.test/pr/7',
          labels: [],
          updatedAt: '',
          author: null
        },
        openModalFallback: () => {}
      })
    const saved = (surface: 'chat' | 'terminal') =>
      mocks.resolveSourceControlActionRecipe.mockReturnValue({
        agentId: 'codex',
        commandInputTemplate: '{basePrompt}',
        surface
      })

    saved('terminal')
    await expect(launch('wt-1')).resolves.toBe(true)
    await expect(launch(null)).resolves.toBe(true)
    saved('chat')
    await expect(launch('wt-1')).resolves.toBe(true)
    await expect(launch(null)).resolves.toBe(true)

    mocks.readSourceControlLaunchRecipeAgentId.mockReturnValue(null)
    mocks.resolveSourceControlActionRecipe.mockReturnValue({ agentId: null })
    await expect(launch(null)).resolves.toBe(true)
    expect(
      mocks.launchWorkItemDirect.mock.calls.every(
        ([args]) => args.agentLaunchPreferences.defaultTuiAgent === 'codex'
      )
    ).toBe(true)
    expect(hostRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'alpha' },
      'settings.getAgentLaunch',
      undefined,
      expect.anything()
    )
    expect(mocks.launchAgentInNewTab.mock.calls.map(([args]) => args.requestedSurface)).toEqual([
      'terminal',
      undefined
    ])
    expect(
      mocks.launchWorkItemDirect.mock.calls.map(([args]) => args.launchChoice?.requestedSurface)
    ).toEqual(['terminal', undefined, undefined])
    clearHostAgentMenuSettingsForTests()
    replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 7 }])
    const pending = Promise.withResolvers<{ settings: typeof preferences }>()
    hostRpc.mockClear().mockReturnValueOnce(pending.promise)
    mocks.launchWorkItemDirect.mockClear()
    saved('terminal')
    mocks.readSourceControlLaunchRecipeAgentId.mockReturnValue('codex')
    const retired = launch(null)
    await vi.waitFor(() => expect(hostRpc).toHaveBeenCalledOnce())
    replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 8 }])
    await expect(retired).resolves.toBe(false)
    pending.reject(new Error('retired pinned request'))
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.launchWorkItemDirect).not.toHaveBeenCalled()
    replaceRuntimeEnvironmentRevisions([])
  })
})
