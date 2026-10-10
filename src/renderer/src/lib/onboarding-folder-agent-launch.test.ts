import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { OnboardingFolderAgentLaunch } from './onboarding-folder-agent-launch'

type RouteState = {
  hostId: string | null
  context: { resolvedLaunchPlatform: NodeJS.Platform; queuedShell: AgentStartupShell | undefined }
  clientPlatform: NodeJS.Platform
}

const mocks = vi.hoisted(() => {
  const state: RouteState = {
    hostId: 'local',
    context: { resolvedLaunchPlatform: 'darwin', queuedShell: undefined },
    clientPlatform: 'darwin'
  }
  return {
    activateAndRevealWorktree: vi.fn((): false | { primaryTabId: string | null } => ({
      primaryTabId: null
    })),
    launchFreshNewTabThroughHost: vi.fn(() => 'tab-1'),
    freshNewTabLaunchesThroughHost: vi.fn(() => true),
    beginStructuredAgentSessionProvisionalLaunch: vi.fn(),
    planAgentSessionLaunch: vi.fn(),
    buildDismissedOnboardingFolderAgentStartup: vi.fn(),
    state
  }
})
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/launch-agent-new-tab-host-route', () => ({
  launchFreshNewTabThroughHost: mocks.launchFreshNewTabThroughHost,
  freshNewTabLaunchesThroughHost: mocks.freshNewTabLaunchesThroughHost
}))
vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: () => mocks.state.hostId
}))
vi.mock('@/lib/launch-agent-execution-context', () => ({
  resolveAgentLaunchExecutionContext: () => mocks.state.context
}))
vi.mock('@/lib/new-workspace', () => ({
  get CLIENT_PLATFORM() {
    return mocks.state.clientPlatform
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))
vi.mock('@/lib/onboarding-folder-agent-startup', () => ({
  buildDismissedOnboardingFolderAgentStartup: mocks.buildDismissedOnboardingFolderAgentStartup
}))

const { resolveDismissedOnboardingFolderAgentLaunch, revealOnboardingFolderWithAgentLaunch } =
  await import('./onboarding-folder-agent-launch')

const STARTUP = {
  command: 'claude',
  launchAgent: 'claude' as const,
  telemetry: {
    agent_kind: 'claude-code' as const,
    launch_source: 'onboarding' as const,
    request_kind: 'new' as const
  }
}
const TERMINAL_LAUNCH: OnboardingFolderAgentLaunch = {
  agent: 'claude',
  plan: null,
  startup: STARTUP
}

function reveal(launch: OnboardingFolderAgentLaunch = TERMINAL_LAUNCH): Promise<void> {
  return revealOnboardingFolderWithAgentLaunch({
    worktreeId: 'repo1::/folder',
    executionHostId: undefined,
    launch
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
  mocks.freshNewTabLaunchesThroughHost.mockReturnValue(true)
  mocks.state.hostId = 'local'
  mocks.state.context = { resolvedLaunchPlatform: 'darwin', queuedShell: undefined }
  mocks.state.clientPlatform = 'darwin'
})

describe('the first folder after dismissed onboarding', () => {
  it('starts its agent through the host as the folder’s only tab', async () => {
    await reveal()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo1::/folder', {
      sidebarRevealBehavior: 'auto',
      providesInitialSurface: true
    })
    expect(mocks.launchFreshNewTabThroughHost).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'repo1::/folder',
      prompt: '',
      launchSource: 'onboarding',
      pendingActivationSpawn: true
    })
    expect(mocks.freshNewTabLaunchesThroughHost).toHaveBeenCalledWith(
      { freshNewTab: true, worktreeId: 'repo1::/folder', agent: 'claude' },
      'darwin'
    )
  })

  it('starts nothing when the folder could not be opened', async () => {
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    await reveal()
    expect(mocks.launchFreshNewTabThroughHost).not.toHaveBeenCalled()
  })

  function expectMainWindowLaunch(): void {
    expect(mocks.launchFreshNewTabThroughHost).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo1::/folder', {
      sidebarRevealBehavior: 'auto',
      startup: STARTUP
    })
  }

  // Why: main builds an SSH or paired-server folder's command with this computer's platform.
  it.each([['ssh:conn-1'], ['runtime:env-1'], [null]])(
    'keeps main’s window launch off this computer (%s)',
    async (hostId) => {
      mocks.state.hostId = hostId
      await reveal()
      expectMainWindowLaunch()
    }
  )

  it('keeps main’s window launch where the plain new-tab route would not take it', async () => {
    mocks.freshNewTabLaunchesThroughHost.mockReturnValue(false)
    await reveal()
    expectMainWindowLaunch()
  })

  // Why: main's builder quotes for this computer's default shell; the host quotes for the setting.
  it.each<[AgentStartupShell | undefined, boolean]>([
    [undefined, true],
    ['powershell', true],
    ['cmd', false],
    ['posix', false]
  ])('on Windows with the %s shell, through the host: %s', async (queuedShell, viaHost) => {
    mocks.state.clientPlatform = 'win32'
    mocks.state.context = { resolvedLaunchPlatform: 'win32', queuedShell }
    await reveal()
    if (viaHost) {
      expect(mocks.launchFreshNewTabThroughHost).toHaveBeenCalledOnce()
    } else {
      expectMainWindowLaunch()
    }
  })

  it('passes the folder’s own launch platform to the new-tab route', async () => {
    mocks.state.clientPlatform = 'win32'
    mocks.state.context = { resolvedLaunchPlatform: 'linux', queuedShell: undefined }
    await reveal()
    expect(mocks.launchFreshNewTabThroughHost).not.toHaveBeenCalled()
  })

  it('opens the folder with no agent when no default agent applies', async () => {
    await reveal({ agent: null, plan: null })
    expect(mocks.launchFreshNewTabThroughHost).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo1::/folder', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('keeps the chat default’s own launch', async () => {
    mocks.buildDismissedOnboardingFolderAgentStartup.mockReturnValue(STARTUP)
    mocks.planAgentSessionLaunch.mockReturnValue({ route: 'structured-native-chat' })
    const launch = resolveDismissedOnboardingFolderAgentLaunch({
      store: {
        repos: [],
        projects: [],
        activeRepoId: null,
        activeWorktreeId: null,
        worktreesByRepo: {},
        projectGroups: [],
        folderWorkspaces: [],
        settings: null
      },
      onboarding: null,
      hasExistingProject: false,
      executionHostId: 'local'
    })
    await reveal(launch)
    expect(mocks.launchFreshNewTabThroughHost).not.toHaveBeenCalled()
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledOnce()
  })
})
