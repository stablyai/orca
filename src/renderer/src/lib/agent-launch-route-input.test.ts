import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type * as ConnectionOwnerResolutionModule from './connection-owner-resolution'

const mocks = vi.hoisted(() => ({
  getExecutionHostIdForWorktree: vi.fn(),
  getConnectionIdFromState: vi.fn(),
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn(),
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn(),
  isWebClientLocation: vi.fn(() => false)
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
vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: mocks.isWebClientLocation
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))
// Why: the planner is the only route consumer; its settle loop is out of scope here.
vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: vi.fn()
}))

import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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
  planAgentSessionLaunch(appStore, { ...args, requestId: 'route-check' }).route
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

function stageLocalStructuredHost(): void {
  vi.clearAllMocks()
  mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
  mocks.getConnectionIdFromState.mockReturnValue(null)
  mocks.getLocalProjectExecutionRuntimeContext.mockReturnValue(undefined)
  mocks.getLocalRepoProjectExecutionRuntimeContext.mockReturnValue(undefined)
  mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue([
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ])
}

describe('buildAgentLaunchRouteInput', () => {
  beforeEach(stageLocalStructuredHost)

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
      startsOutsideWorkspaceRoot: false,
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
    // Still skipped: floating has no project row, so there is no local runtime preference to read.
    expect(input.projectRuntime).toBeUndefined()
    expect(mocks.getLocalProjectExecutionRuntimeContext).not.toHaveBeenCalled()
    // Feasible now: the workspace resolves to its configured directory, so a session can be
    // filed under it. Skipping the project runtime is about the missing repo row, not a refusal.
    expect(
      structuredFeasibleFor(store(), {
        agent: 'codex',
        workspace: { kind: 'floating', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      })
    ).toBe(true)
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

  it('requires a terminal for a cwd outside the workspace root', () => {
    const input = buildAgentLaunchRouteInput(store(), {
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      tuiCustomization: { cwd: '/repo/sub' }
    })
    expect(input.startsOutsideWorkspaceRoot).toBe(true)
  })

  // Command values never change the selected chat surface.
  it.each([
    ['claude', 'claude-wrapper'],
    ['codex', 'codex-nightly'],
    ['claude', 'npx claude'],
    ['codex', 'wrapper --arg'],
    ['claude', '/missing/claude'],
    ['codex', './codex']
  ] as const)('keeps %s structured with launch command %s', (agent, command) => {
    const appStore = store({ ...STRUCTURED_SETTINGS, agentCmdOverrides: { [agent]: command } })
    const args = {
      agent,
      workspace: { kind: 'git-worktree' as const, worktreeId: 'wt-1' }
    }
    expect(buildAgentLaunchRouteInput(appStore, args).startsOutsideWorkspaceRoot).toBe(false)
    expect(routeFor(appStore, args)).toBe('structured-native-chat')
    expect(structuredFeasibleFor(appStore, args)).toBe(true)
  })

  // The reported P0: `--dangerously-skip-permissions --model Opus` matched no blessed string, so
  // every new Claude tab was silently demoted to the terminal-backed chat. The Arguments field is
  // a terminal concern and no longer reaches this decision.
  it.each([
    ['claude', '--dangerously-skip-permissions --model Opus'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol'],
    ['claude', '--append-system-prompt "be brief"']
  ] as const)('keeps %s structured with configured arguments %s', (agent, agentArgs) => {
    const appStore = store({
      ...STRUCTURED_SETTINGS,
      agentDefaultArgs: { [agent]: agentArgs },
      agentDefaultEnv: { [agent]: { ORCA_QA: '1' } }
    })
    const args = {
      agent,
      workspace: { kind: 'git-worktree' as const, worktreeId: 'wt-1' }
    }
    expect(routeFor(appStore, args)).toBe('structured-native-chat')
    expect(buildAgentLaunchRouteInput(appStore, args).startsOutsideWorkspaceRoot).toBe(false)
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

  describe('a workspace on a paired server', () => {
    const CURRENT_SERVER = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ]
    const args: AgentLaunchRouteArgs = {
      agent: 'claude',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    }
    // The store's host status is what a paired server last reported about itself.
    const pairedStore = (
      capabilities: readonly string[],
      settings: Record<string, unknown> = STRUCTURED_SETTINGS
    ): AgentLaunchRouteStore =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the slices the input reads are staged.
      ({
        settings,
        runtimeStatusByEnvironmentId: new Map([['server-1', { status: { capabilities } }]])
      }) as unknown as AgentLaunchRouteStore

    beforeEach(() => {
      mocks.getExecutionHostIdForWorktree.mockReturnValue('runtime:server-1')
      mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue([])
    })

    it("reads the server's own capabilities from its host status, not this machine's", () => {
      expect(
        buildAgentLaunchRouteInput(pairedStore(CURRENT_SERVER), args).hostCapabilities
      ).toEqual(CURRENT_SERVER)
      expect(routeFor(pairedStore(CURRENT_SERVER), args)).toBe('structured-native-chat')
    })

    it('treats a server that has not reported its status as unknown', () => {
      expect(buildAgentLaunchRouteInput(store(), args).hostCapabilities).toBeNull()
      expect(routeFor(store(), args)).toBe('legacy-native-chat')
    })

    // A released server advertises structured sessions but admits them only with its own chat
    // setting on; a chat opened there could never start.
    it('keeps the terminal on a server that predates client-chosen launch modes', () => {
      expect(routeFor(pairedStore([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]), args)).toBe(
        'legacy-native-chat'
      )
    })

    // The browser client's handshake never says it reads structured sessions, so the server
    // would refuse its chat.
    it('keeps the host terminal for a browser client', () => {
      mocks.isWebClientLocation.mockReturnValue(true)
      try {
        expect(routeFor(pairedStore(CURRENT_SERVER), args)).toBe('legacy-native-chat')
      } finally {
        mocks.isWebClientLocation.mockReturnValue(false)
      }
    })

    // A launch command override never decides the surface, here or on the server.
    it("does not route on this machine's launch command override for the server", () => {
      const settings = { ...STRUCTURED_SETTINGS, agentCmdOverrides: { claude: 'claude-wrapper' } }
      expect(
        buildAgentLaunchRouteInput(pairedStore(CURRENT_SERVER, settings), args)
          .startsOutsideWorkspaceRoot
      ).toBe(false)
      expect(routeFor(pairedStore(CURRENT_SERVER, settings), args)).toBe('structured-native-chat')
    })
  })

  it('does not name a host for a workspace id two hosts publish', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the slices the input reads are staged.
    const colliding = {
      settings: STRUCTURED_SETTINGS,
      activeWorktreeId: 'other',
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-1', repoId: 'repo-1', hostId: 'local' },
          { id: 'wt-1', repoId: 'repo-1', hostId: 'runtime:server-1' }
        ]
      }
    } as unknown as AgentLaunchRouteStore
    const input = buildAgentLaunchRouteInput(colliding, {
      agent: 'claude',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })
    expect(input.hostCapabilities).toBeNull()
    expect(
      routeFor(colliding, {
        agent: 'claude',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
      })
    ).toBe('legacy-native-chat')
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

describe('a cwd that names the workspace root', () => {
  // "Hand Off to Another Agent" always names a cwd; at the root it must not force a terminal.
  beforeEach(stageLocalStructuredHost)

  const withRoot = (): AgentLaunchRouteStore =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route store is the app state narrowed to the slices the input reads; only those are staged.
    ({
      settings: STRUCTURED_SETTINGS,
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', path: '/repo/app' }] },
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/srv/notes' }]
    }) as unknown as AgentLaunchRouteStore

  it.each(['/repo/app', '/repo/app/', '.'])(
    'routes structured under the chat default for cwd %s',
    (cwd) => {
      const args = {
        agent: 'codex' as const,
        workspace: { kind: 'git-worktree' as const, worktreeId: 'wt-1' },
        tuiCustomization: { cwd }
      }
      expect(buildAgentLaunchRouteInput(withRoot(), args).startsOutsideWorkspaceRoot).toBe(false)
      expect(routeFor(withRoot(), args)).toBe('structured-native-chat')
    }
  )

  it('still requires a terminal for a subdirectory, which a structured session cannot start in', () => {
    const args = {
      agent: 'codex' as const,
      workspace: { kind: 'git-worktree' as const, worktreeId: 'wt-1' },
      tuiCustomization: { cwd: '/repo/app/packages/web' }
    }
    expect(buildAgentLaunchRouteInput(withRoot(), args).startsOutsideWorkspaceRoot).toBe(true)
    expect(routeFor(withRoot(), args)).not.toBe('structured-native-chat')
  })

  it('reads a folder workspace root the same way', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const at = (cwd: string) =>
      buildAgentLaunchRouteInput(withRoot(), {
        agent: 'codex',
        workspace: { kind: 'folder', worktreeId: workspaceId },
        tuiCustomization: { cwd }
      }).startsOutsideWorkspaceRoot
    expect(at('/srv/notes/')).toBe(false)
    expect(at('/srv/notes/drafts')).toBe(true)
  })
})
