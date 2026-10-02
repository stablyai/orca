import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { ForkableAgentSession } from './worktree-agent-fork-sessions'
import {
  launchNativeAgentSessionFork,
  launchTranscriptAgentSessionFork
} from './agent-session-fork-launch'

type CreateTabOptions = Parameters<AppState['createTab']>[3]
type LaunchSurface = { kind: 'local-terminal' | 'local-agent-session'; tabId: string }
type LaunchAgentArgs = {
  agent: string
  worktreeId: string
  prompt: string
  promptDelivery: string
  launchSource: string
  launchPlatform?: NodeJS.Platform
  beforeSurfaceOpen?: (surface: LaunchSurface) => boolean
}
type Worktree = { id: string; repoId: string; path: string }
type Repo = { id: string; connectionId?: string | null }
type Settings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
}
type MockState = {
  createTab: typeof createTab
  setActiveTabType: ReturnType<typeof vi.fn>
  settings: Settings
  repos: Repo[]
  getKnownWorktreeById: (id: string) => Worktree | undefined
}

const createTab = vi.fn(
  (
    _worktreeId: string,
    _groupId?: string,
    _shellOverride?: string,
    _options?: CreateTabOptions
  ) => ({
    id: 'tab-fork'
  })
)
const knownWorktrees = new Map<string, Worktree>()
const state: MockState = {
  createTab,
  setActiveTabType: vi.fn(),
  settings: { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} },
  repos: [],
  getKnownWorktreeById: (id: string): Worktree | undefined => knownWorktrees.get(id)
}

const mocks = vi.hoisted(() => ({
  preflightAgentTrust: vi.fn(async (_args: unknown) => undefined),
  getForkAgentLaunchTarget: vi.fn(
    (
      _state: unknown,
      _worktreeId: string
    ): { platform: string; shell: undefined; runtimeEnvironmentId: string | null } => ({
      platform: 'linux',
      shell: undefined,
      runtimeEnvironmentId: null
    })
  ),
  createWebRuntimeSessionTerminal: vi.fn(
    async (_args: Record<string, unknown>): Promise<{ status: string; message?: string }> => ({
      status: 'created'
    })
  ),
  appendTabToWorktreeOrder: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  planAgentSessionLaunch: vi.fn((_store: unknown, _request: unknown) => ({ route: 'terminal' })),
  activateAndRevealWorktree: vi.fn((_worktreeId: string, _options?: unknown) => true)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/sleeping-agent-session-launch', () => ({
  appendTabToWorktreeOrder: mocks.appendTabToWorktreeOrder
}))
vi.mock('./agent-session-fork-launch-target', () => ({
  getForkAgentLaunchTarget: mocks.getForkAgentLaunchTarget
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/lib/agent-trust-preflight', () => ({ preflightAgentTrust: mocks.preflightAgentTrust }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mocks.planAgentSessionLaunch
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/telemetry', () => ({ tuiAgentToAgentKind: (agent: string) => agent }))

function makeSession(overrides: Partial<ForkableAgentSession> = {}): ForkableAgentSession {
  return {
    providerSessionId: 'sess-1',
    paneKey: 'tab-1:leaf-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    launchConfig: { agentArgs: '--model sonnet', agentEnv: { CLAUDE_CONFIG_DIR: '/acct' } },
    title: 'Claude',
    lastActiveAt: 1,
    live: true,
    ...overrides
  }
}

function lastCreateTabOptions(): CreateTabOptions {
  return createTab.mock.calls.at(-1)?.[3]
}

beforeEach(() => {
  vi.clearAllMocks()
  state.settings = { agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} }
  state.repos = [{ id: 'repo', connectionId: null }]
  knownWorktrees.clear()
  knownWorktrees.set('repo::child', { id: 'repo::child', repoId: 'repo', path: '/r/child' })
})

describe('launchNativeAgentSessionFork', () => {
  it('opens a terminal tab running the fork command without claiming the source session', async () => {
    const ok = await launchNativeAgentSessionFork({
      session: makeSession(),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: null,
      launchSource: 'sidebar'
    })

    expect(ok).toBe(true)
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(createTab.mock.calls[0]?.[0]).toBe('repo::child')
    const options = lastCreateTabOptions()
    expect(options?.pendingStartup?.command).toBe(
      "claude '--model' 'sonnet' '--resume' 'sess-1' '--fork-session'"
    )
    expect(options?.pendingStartup?.env).toEqual({ CLAUDE_CONFIG_DIR: '/acct' })
    expect(options?.pendingStartup?.resumeProviderSession).toBeUndefined()
    expect(options?.automaticResumeClaim).toBeUndefined()
    expect(options?.pendingStartup?.telemetry).toMatchObject({
      launch_source: 'sidebar',
      request_kind: 'resume'
    })
    expect(mocks.getForkAgentLaunchTarget).toHaveBeenCalledWith(state, 'repo::child')
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'claude',
      workspacePath: '/r/child',
      connectionId: undefined
    })
    expect(state.setActiveTabType).toHaveBeenCalledWith('terminal', 'repo::child')
    expect(mocks.appendTabToWorktreeOrder).toHaveBeenCalledWith('repo::child', 'tab-fork')
  })

  it('runs codex fork on the SSH host with the source account env', async () => {
    const ok = await launchNativeAgentSessionFork({
      session: makeSession({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-9' },
        launchConfig: { agentArgs: '', agentEnv: { CODEX_HOME: '/acct/codex' } }
      }),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: 'ssh-1',
      launchSource: 'terminal_context_menu'
    })

    expect(ok).toBe(true)
    const options = lastCreateTabOptions()
    expect(options?.pendingStartup?.command).toMatch(/^codex .*'fork' 'thread-9'$/)
    expect(options?.pendingStartup?.env).toEqual({ CODEX_HOME: '/acct/codex' })
    expect(options?.pendingStartup?.telemetry).toMatchObject({
      launch_source: 'terminal_context_menu'
    })
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'codex',
      workspacePath: '/r/child',
      connectionId: 'ssh-1'
    })
  })

  it("falls back to the user's default args and env without a source launch config", async () => {
    state.settings.agentDefaultArgs = { claude: '--verbose' }
    state.settings.agentDefaultEnv = { claude: { CLAUDE_CONFIG_DIR: '/default' } }

    await launchNativeAgentSessionFork({
      session: makeSession({ launchConfig: null }),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: null,
      launchSource: 'sidebar'
    })

    const options = lastCreateTabOptions()
    expect(options?.pendingStartup?.command).toContain("'--verbose'")
    expect(options?.pendingStartup?.env).toEqual({ CLAUDE_CONFIG_DIR: '/default' })
    expect(options?.pendingStartup?.agentArgsOverride).toBeUndefined()
  })

  it('creates the fork tab on the runtime host for a runtime-owned workspace', async () => {
    mocks.getForkAgentLaunchTarget.mockReturnValueOnce({
      platform: 'linux',
      shell: undefined,
      runtimeEnvironmentId: 'env-1'
    })

    const ok = await launchNativeAgentSessionFork({
      session: makeSession(),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: null,
      launchSource: 'sidebar'
    })

    expect(ok).toBe(true)
    expect(createTab).not.toHaveBeenCalled()
    expect(mocks.appendTabToWorktreeOrder).not.toHaveBeenCalled()
    // Why: a local trust write would describe the client's disk, not the host running the agent.
    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'repo::child',
      environmentId: 'env-1',
      agentSessionKind: 'resume',
      launchAgent: 'claude',
      command: "claude '--model' 'sonnet' '--resume' 'sess-1' '--fork-session'",
      env: { CLAUDE_CONFIG_DIR: '/acct' },
      launchConfig: expect.objectContaining({ agentArgs: '--model sonnet' }),
      agentArgs: '--model sonnet',
      // Why: omitted, a host that defaults Claude to chat would open the terminal fork in chat.
      viewMode: 'terminal',
      activate: true
    })
    const runtimeArgs = mocks.createWebRuntimeSessionTerminal.mock.calls[0]?.[0]
    expect(runtimeArgs).not.toHaveProperty('providerSession')
    expect(state.setActiveTabType).toHaveBeenCalledWith('terminal', 'repo::child')
  })

  it('reports a runtime host that could not create the fork tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocks.getForkAgentLaunchTarget.mockReturnValueOnce({
      platform: 'linux',
      shell: undefined,
      runtimeEnvironmentId: 'env-1'
    })
    mocks.createWebRuntimeSessionTerminal.mockResolvedValueOnce({
      status: 'failed',
      message: 'host disconnected'
    })

    const ok = await launchNativeAgentSessionFork({
      session: makeSession(),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: null,
      launchSource: 'sidebar'
    })

    expect(ok).toBe(false)
    expect(createTab).not.toHaveBeenCalled()
    expect(state.setActiveTabType).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[agent-session-fork] runtime host did not open the fork',
      'host disconnected'
    )
    warn.mockRestore()
  })

  it('returns false and opens nothing when no fork command can be built', async () => {
    const ok = await launchNativeAgentSessionFork({
      session: makeSession({
        providerSessionId: '',
        providerSession: { key: 'session_id', id: '' }
      }),
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      connectionId: null,
      launchSource: 'sidebar'
    })

    expect(ok).toBe(false)
    expect(createTab).not.toHaveBeenCalled()
    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
  })
})

describe('launchTranscriptAgentSessionFork', () => {
  function mockLaunchResult(surface: LaunchSurface | null): void {
    mocks.launchAgentInNewTab.mockImplementation((args: LaunchAgentArgs) => {
      if (surface) {
        args.beforeSurfaceOpen?.(surface)
      }
      return surface ? { surface, startupPlan: {}, pasteDraftAfterLaunch: true } : null
    })
  }

  it('launches a fresh agent with the transcript as a draft prompt', async () => {
    mockLaunchResult({ kind: 'local-terminal', tabId: 't' })

    const ok = await launchTranscriptAgentSessionFork({
      agent: 'gemini',
      prompt: 'fork context',
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      launchSource: 'terminal_context_menu'
    })

    expect(ok).toBe(true)
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'gemini',
        worktreeId: 'repo::child',
        prompt: 'fork context',
        promptDelivery: 'draft',
        launchSource: 'terminal_context_menu'
      })
    )
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'gemini',
      workspacePath: '/r/child',
      connectionId: null
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::child', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('launches with the POSIX platform on an SSH worktree', async () => {
    state.repos = [{ id: 'repo', connectionId: 'ssh-1' }]
    mockLaunchResult({ kind: 'local-terminal', tabId: 't' })

    await launchTranscriptAgentSessionFork({
      agent: 'gemini',
      prompt: 'fork context',
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      launchSource: 'sidebar'
    })

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ launchPlatform: 'linux', launchSource: 'sidebar' })
    )
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' })
    )
  })

  it('skips the trust preflight for a structured native chat launch', async () => {
    mocks.planAgentSessionLaunch.mockReturnValueOnce({ route: 'structured-native-chat' })
    mockLaunchResult({ kind: 'local-agent-session', tabId: 't' })

    await launchTranscriptAgentSessionFork({
      agent: 'claude',
      prompt: 'fork context',
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      launchSource: 'sidebar'
    })

    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::child', {
      sidebarRevealBehavior: 'auto',
      providesInitialSurface: true
    })
  })

  it('returns false when no agent surface could be opened', async () => {
    mockLaunchResult(null)

    const ok = await launchTranscriptAgentSessionFork({
      agent: 'gemini',
      prompt: 'fork context',
      worktreeId: 'repo::child',
      worktreePath: '/r/child',
      launchSource: 'sidebar'
    })

    expect(ok).toBe(false)
  })
})
