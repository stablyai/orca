import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { buildAgentLaunchRouteInput } from './agent-launch-route-input'
import type { AgentLaunchRouteArgs, AgentLaunchRouteStore } from './agent-launch-route-input'
import { planAgentSessionLaunch } from './agent-session-launch-plan'
import type * as ConnectionOwnerResolutionModule from '../../../workspace/ownership/connection-owner-resolution'

const mocks = vi.hoisted(() => ({
  getExecutionHostIdForWorktree: vi.fn(),
  getConnectionIdFromState: vi.fn(),
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn(),
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn(),
  isWebClientLocation: vi.fn(() => false)
}))

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))
// Stage only workspace ownership; repo fallback must use the real resolver.
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionOwnerResolutionModule>()),
  getConnectionIdFromState: mocks.getConnectionIdFromState
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: mocks.getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext: mocks.getLocalRepoProjectExecutionRuntimeContext
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: mocks.isWebClientLocation
}))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))
vi.mock('@/lib/agent-session/launch/continuation/structured-agent-launch-settlement', () => ({}))

const routeFor = (appStore: AgentLaunchRouteStore, args: AgentLaunchRouteArgs) =>
  planAgentSessionLaunch(appStore, { ...args, requestId: 'route-check' }).route

const STRUCTURED_SETTINGS = {
  nativeChatProviders: EVERY_AGENT_CHAT,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
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

  describe('a workspace on a paired server', () => {
    const CURRENT_SERVER = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ]
    const args: AgentLaunchRouteArgs = {
      agent: 'claude',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    }
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

    it('treats a server that has not reported its status as unknown', () => {
      expect(buildAgentLaunchRouteInput(store(), args).hostCapabilities).toBeNull()
      expect(routeFor(store(), args)).toBe('terminal-tui')
    })

    // Older servers require their own chat setting to admit structured sessions despite advertising capability.
    it('keeps the terminal on a server that predates client-chosen launch modes', () => {
      expect(routeFor(pairedStore([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]), args)).toBe(
        'terminal-tui'
      )
    })

    it('opens a chat for a browser client too', () => {
      mocks.isWebClientLocation.mockReturnValue(true)
      try {
        expect(routeFor(pairedStore(CURRENT_SERVER), args)).toBe('structured-native-chat')
      } finally {
        mocks.isWebClientLocation.mockReturnValue(false)
      }
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
    ).toBe('terminal-tui')
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
