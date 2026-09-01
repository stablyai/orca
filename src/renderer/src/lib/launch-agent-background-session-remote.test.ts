// Remote-host routing for background agent launches. The runtime-environment
// create/close/subscribe scenarios live in launch-agent-background-session.test.ts;
// what is unique here is which host a launch lands on, and refusing a host too old
// to resolve the identity. The client-side SSH startup-delivery family is gone with
// U3 — the host now folds the prompt into the command it resolves.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness,
  useRemoteAgentBackgroundRuntime
} from '@/lib/agent-background-session-test-state'
import { AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE } from '@/runtime/agent-launch-identity-negotiation'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockMarkTrusted = vi.fn()
const mockDispatchEvent = vi.fn()
const mockGetAgentLaunchPlatformForRepo = vi.fn<() => NodeJS.Platform>()
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: vi.fn(() => () => {})
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-launch-platform', () => ({
  getAgentLaunchPlatformForRepo: mockGetAgentLaunchPlatformForRepo
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

describe('launchAgentBackgroundSession remote host routing', () => {
  beforeEach(() => {
    resetAgentBackgroundSessionTestHarness({
      state,
      createTab: mockCreateTab,
      closeTab: mockCloseTab,
      getLaunchPlatform: mockGetAgentLaunchPlatformForRepo,
      runtimeCall: mockRuntimeEnvironmentCall,
      runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
      runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
      subscribeToData: mockSubscribeToPtyData,
      subscribeToExit: mockSubscribeToPtyExit,
      setTabLayout: mockSetTabLayout,
      updateTabPtyId: mockUpdateTabPtyId,
      dispatchEvent: mockDispatchEvent,
      kill: mockKill,
      markTrusted: mockMarkTrusted,
      spawn: mockSpawn,
      write: mockWrite
    })
  })

  it('refuses to launch on a remote host that cannot resolve the agent identity', async () => {
    // A pre-identity host strips the unknown agentLaunch key and spawns a bare
    // login shell, then answers with a terminal — so the client must fail closed
    // rather than report a launched agent. There is no client command to fall
    // back to on this path.
    useRemoteAgentBackgroundRuntime(state)
    mockRuntimeEnvironmentTransportCall.mockImplementation((request: { method: string }) => {
      if (request.method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        })
      }
      return Promise.resolve({
        id: 'create',
        ok: true,
        result: { terminal: { handle: 'legacy-terminal-1' } }
      })
    })
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run remotely'
      })
    ).rejects.toThrow(AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)

    expect(mockRuntimeEnvironmentTransportCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('spawns an SSH folder-workspace automation on the owning host, not locally', async () => {
    // Folder workspaces have no repo row, so launch ownership comes from their scope.
    state.repos = [
      { id: 'repo-1', connectionId: 'ssh-1', path: '/srv/proj/api', projectGroupId: 'grp-1' }
    ]
    state.projectGroups = [{ id: 'grp-1', parentGroupId: null, connectionId: 'ssh-1' }]
    state.folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'grp-1', folderPath: '/srv/proj', connectionId: 'ssh-1' }
    ]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-1' ? { id: 'folder:fw-1', path: '/srv/proj' } : undefined
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'codex',
      worktreeId: 'folder:fw-1',
      prompt: 'run the automation'
    })

    expect(mockMarkTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/srv/proj',
      connectionId: 'ssh-1'
    })
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', cwd: '/srv/proj' })
    )
  })

  it('keeps a local folder workspace on the local host', async () => {
    state.repos = [
      { id: 'repo-1', connectionId: null, path: '/home/me/proj/api', projectGroupId: 'grp-1' }
    ]
    state.projectGroups = [{ id: 'grp-1', parentGroupId: null, connectionId: null }]
    state.folderWorkspaces = [
      { id: 'fw-1', projectGroupId: 'grp-1', folderPath: '/home/me/proj', connectionId: null }
    ]
    state.getKnownWorktreeById = (worktreeId: string) =>
      worktreeId === 'folder:fw-1' ? { id: 'folder:fw-1', path: '/home/me/proj' } : undefined
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'folder:fw-1',
      prompt: 'run the automation'
    })

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: null, cwd: '/home/me/proj' })
    )
  })
})
