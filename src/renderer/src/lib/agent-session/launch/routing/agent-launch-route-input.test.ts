import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { buildAgentLaunchRouteInput } from './agent-launch-route-input'
import type { AgentLaunchRouteStore } from './agent-launch-route-input'
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

const STRUCTURED_SETTINGS = {
  nativeChatProviders: EVERY_AGENT_CHAT,
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
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

describe('a cwd that names the workspace root', () => {
  // "Hand off to agent" always names a cwd; at the root it must not force a terminal.
  beforeEach(stageLocalStructuredHost)

  const withRoot = (): AgentLaunchRouteStore =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route store is the app state narrowed to the slices the input reads; only those are staged.
    ({
      settings: STRUCTURED_SETTINGS,
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', path: '/repo/app' }] },
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/srv/notes' }]
    }) as unknown as AgentLaunchRouteStore

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
