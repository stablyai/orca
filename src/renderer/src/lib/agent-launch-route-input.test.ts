import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type * as ConnectionOwnerResolutionModule from './connection-owner-resolution'

const mocks = vi.hoisted(() => ({
  getExecutionHostIdForWorktree: vi.fn(),
  getConnectionIdFromState: vi.fn(),
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn(),
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))
// Why the partial mock: only the worktree-owner answer is staged here; the repo fallback must be
// the real resolver, since it is what this suite pins.
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionOwnerResolutionModule>()),
  getConnectionIdFromState: mocks.getConnectionIdFromState
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: mocks.getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext: mocks.getLocalRepoProjectExecutionRuntimeContext
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))
// Why: the planner is the only route consumer; its settle loop is out of scope here.
vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: vi.fn()
}))

import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type AgentLaunchRouteArgs,
  type AgentLaunchRouteStore
} from './agent-launch-route-input'
import {
  planAgentSessionLaunch,
  structuredAgentSessionLaunchFeasible
} from './agent-session-launch-plan'

const routeFor = (appStore: AgentLaunchRouteStore, args: AgentLaunchRouteArgs) =>
  planAgentSessionLaunch(appStore, args).route
const structuredFeasibleFor = (appStore: AgentLaunchRouteStore, args: AgentLaunchRouteArgs) =>
  structuredAgentSessionLaunchFeasible(appStore, { ...args, settings: STRUCTURED_SETTINGS })

const STRUCTURED_SETTINGS = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}

const WSL_RUNTIME: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'wsl'
  }
}

function store(settings: Record<string, unknown> = STRUCTURED_SETTINGS): AgentLaunchRouteStore {
  return { settings } as unknown as AgentLaunchRouteStore
}

describe('buildAgentLaunchRouteInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    mocks.getConnectionIdFromState.mockReturnValue(null)
    mocks.getLocalProjectExecutionRuntimeContext.mockReturnValue(undefined)
    mocks.getLocalRepoProjectExecutionRuntimeContext.mockReturnValue(undefined)
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
  })

  it('gathers the full input set for an existing local git worktree', () => {
    mocks.getLocalProjectExecutionRuntimeContext.mockReturnValue(WSL_RUNTIME)
    const appStore = store()
    const input = buildAgentLaunchRouteInput(appStore, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      prompt: 'fix the flaky test',
      promptDelivery: 'auto-submit',
      initialSessionOptions: { model: 'gpt-5.4' }
    })
    expect(input).toEqual({
      agent: 'codex',
      settings: STRUCTURED_SETTINGS,
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      workspaceKind: 'git-worktree',
      projectRuntime: WSL_RUNTIME,
      promptDelivery: 'auto-submit',
      launchText: 'fix the flaky test',
      nativeChatTranscriptIsLocalReadable: true,
      requiresTuiLaunchCustomization: false,
      initialSessionOptions: { model: 'gpt-5.4' }
    })
    expect(mocks.getExecutionHostIdForWorktree).toHaveBeenCalledWith(appStore, 'wt-1')
    expect(mocks.getLocalProjectExecutionRuntimeContext).toHaveBeenCalledWith(appStore, 'wt-1')
    expect(mocks.getLocalRepoProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(
      routeFor(appStore, {
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
      })
    ).toBe('legacy-native-chat')
  })

  it('never consults the local project runtime for a worktree on an SSH connection', () => {
    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:build-box')
    mocks.getConnectionIdFromState.mockReturnValue('build-box')
    const input = buildAgentLaunchRouteInput(store(), {
      agent: 'claude',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-remote' }
    })
    expect(input.executionHostId).toBe('ssh:build-box')
    expect(input.projectRuntime).toBeUndefined()
    expect(input.nativeChatTranscriptIsLocalReadable).toBe(false)
    expect(mocks.getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(mocks.getLocalRepoProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(
      structuredFeasibleFor(store(), {
        agent: 'claude',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-remote' }
      })
    ).toBe(false)
  })

  it('resolves a prospective git worktree from its repo', () => {
    mocks.getLocalRepoProjectExecutionRuntimeContext.mockReturnValue(WSL_RUNTIME)
    const appStore = store()
    const input = buildAgentLaunchRouteInput(appStore, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1' },
      prompt: 'issue body',
      promptDelivery: 'draft'
    })
    expect(input.executionHostId).toBe('local')
    expect(input.projectRuntime).toBe(WSL_RUNTIME)
    expect(mocks.getLocalRepoProjectExecutionRuntimeContext).toHaveBeenCalledWith(
      appStore,
      'repo-1'
    )
    expect(mocks.getExecutionHostIdForWorktree).not.toHaveBeenCalled()
    expect(mocks.getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(
      routeFor(appStore, {
        agent: 'codex',
        workspace: { kind: 'git-worktree', repoId: 'repo-1' },
        prompt: 'issue body',
        promptDelivery: 'draft'
      })
    ).toBe('legacy-native-chat')
  })

  it.each([
    [
      'an explicit host',
      { kind: 'git-worktree', repoId: 'repo-1', executionHostId: 'ssh:box' },
      'ssh:box',
      false
    ],
    [
      'a runtime-owned SSH host',
      { kind: 'git-worktree', executionHostId: 'ssh:runtime-ssh-1' },
      'ssh:runtime-ssh-1',
      true
    ],
    [
      'a pending ephemeral VM',
      { kind: 'git-worktree', repoId: 'repo-1', executionHostId: 'runtime:pending-ephemeral-vm' },
      'runtime:pending-ephemeral-vm',
      true
    ]
  ] as const)(
    'keeps a prospective workspace on %s off the local project runtime',
    (_name, workspace, executionHostId, readable) => {
      const input = buildAgentLaunchRouteInput(store(), { agent: 'codex', workspace })
      expect(input.executionHostId).toBe(executionHostId)
      expect(input.projectRuntime).toBeUndefined()
      expect(input.nativeChatTranscriptIsLocalReadable).toBe(readable)
      expect(mocks.getLocalRepoProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    }
  )

  it('names the runtime environment as the host of a prospective folder workspace', () => {
    const input = buildAgentLaunchRouteInput(store(), {
      agent: 'claude',
      workspace: { kind: 'folder', runtimeEnvironmentId: 'env 1', executionHostId: 'ssh:ignored' },
      prompt: 'note',
      promptDelivery: 'auto-submit'
    })
    expect(input.executionHostId).toBe('runtime:env%201')
    expect(input.workspaceKind).toBe('folder')
    expect(input.projectRuntime).toBeUndefined()
    expect(input.nativeChatTranscriptIsLocalReadable).toBe(true)
  })

  it('marks the floating workspace and skips its project runtime', () => {
    const input = buildAgentLaunchRouteInput(store(), {
      agent: 'codex',
      workspace: { kind: 'floating', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    })
    expect(input.workspaceKind).toBe('floating')
    expect(input.projectRuntime).toBeUndefined()
    expect(mocks.getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    expect(
      structuredFeasibleFor(store(), {
        agent: 'codex',
        workspace: { kind: 'floating', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      })
    ).toBe(false)
  })

  it('passes a draft prompt through and never turns it into a blocker', () => {
    const args = {
      agent: 'codex' as const,
      workspace: { kind: 'git-worktree' as const, worktreeId: 'wt-1' },
      prompt: 'edit me first',
      promptDelivery: 'draft' as const
    }
    expect(buildAgentLaunchRouteInput(store(), args).promptDelivery).toBe('draft')
    expect(routeFor(store(), args)).toBe('structured-native-chat')
    expect(structuredFeasibleFor(store(), args)).toBe(true)
  })

  it.each([
    ['a cwd', { cwd: '/repo/sub' }, {}],
    ['explicit agent args', { agentArgs: '--model gpt-5.4' }, {}],
    ['a settings command override', {}, { agentCmdOverrides: { codex: 'codex-nightly' } }]
  ] as const)('requires a terminal for %s', (_name, tuiCustomization, settingsOverride) => {
    const input = buildAgentLaunchRouteInput(
      store({ ...STRUCTURED_SETTINGS, ...settingsOverride }),
      {
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        tuiCustomization
      }
    )
    expect(input.requiresTuiLaunchCustomization).toBe(true)
  })

  // Grok reads its transcript off local disk, so it is the agent the readability answer routes on.
  const NATIVE_CHAT_SETTINGS = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
  const UNLANDED_WORKSPACE = {
    kind: 'git-worktree',
    worktreeId: 'repo-1::/repo/wt-1',
    repoId: 'repo-1'
  } as const

  it('falls back to the repo when the worktree row has not landed yet', () => {
    // Why: "Use" on a PR plans the route in the window between creating the workspace and its row
    // reaching the store; an unresolved owner there must not downgrade native chat to a terminal.
    mocks.getConnectionIdFromState.mockReturnValue(undefined)
    const appStore = {
      settings: NATIVE_CHAT_SETTINGS,
      repos: [{ id: 'repo-1', path: '/repo', connectionId: null }],
      worktreesByRepo: {}
    } as unknown as AgentLaunchRouteStore
    expect(
      buildAgentLaunchRouteInput(appStore, { agent: 'grok', workspace: UNLANDED_WORKSPACE })
        .nativeChatTranscriptIsLocalReadable
    ).toBe(true)
    expect(routeFor(appStore, { agent: 'grok', workspace: UNLANDED_WORKSPACE })).toBe(
      'legacy-native-chat'
    )
  })

  it('keeps a worktree on an unresolvable repo off native chat', () => {
    mocks.getConnectionIdFromState.mockReturnValue(undefined)
    const appStore = {
      settings: NATIVE_CHAT_SETTINGS,
      repos: [],
      worktreesByRepo: {}
    } as unknown as AgentLaunchRouteStore
    expect(routeFor(appStore, { agent: 'grok', workspace: UNLANDED_WORKSPACE })).toBe(
      'terminal-tui'
    )
  })

  it('never lets the repo answer over a resolved local worktree owner', () => {
    mocks.getConnectionIdFromState.mockReturnValue(null)
    const appStore = {
      settings: NATIVE_CHAT_SETTINGS,
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'build-box' }],
      worktreesByRepo: {}
    } as unknown as AgentLaunchRouteStore
    expect(routeFor(appStore, { agent: 'grok', workspace: UNLANDED_WORKSPACE })).toBe(
      'legacy-native-chat'
    )
  })

  it('reports an unprobed host as unknown rather than unsupported', () => {
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(null)
    const input = buildAgentLaunchRouteInput(store(), {
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })
    expect(input.hostCapabilities).toBeNull()
  })
})

describe('workspaceKindForWorktreeId', () => {
  it.each([
    [FLOATING_TERMINAL_WORKTREE_ID, 'floating'],
    ['folder:ws-1', 'folder'],
    ['repo-1::/repo/orca', 'git-worktree']
  ])('classifies %s as %s', (worktreeId, kind) => {
    expect(workspaceKindForWorktreeId(worktreeId)).toBe(kind)
  })
})
