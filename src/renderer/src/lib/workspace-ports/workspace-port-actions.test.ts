import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  RUNTIME_BROWSER_UNAVAILABLE_MESSAGE,
  getWorkspaceClientCreationActionPolicy,
  runtimeHostsPagesOnThisDesktop
} from '../client-creation-action-policy'
import { isSshDeploymentClientBrowserRoute } from '../browser/workspace/workspace-browser-route-eligibility'
import { resolveWorktreeOperationRoute } from '../workspace/ownership/worktree-operation-route'

const WORKTREE_ID = 'repo::/srv/app'
const ENVIRONMENT_ID = 'env-ssh'
const HOST_ID = 'runtime:env-ssh'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn(),
  openWorkspaceBrowserTab: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertCapability
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', () => ({
  openWorkspaceBrowserTab: mocks.openWorkspaceBrowserTab
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { openWorkspacePortInBrowser } from './workspace-port-actions'

const CLIENT_HOST_CAPABILITIES = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
]

const port: WorkspacePort = {
  id: '127.0.0.1:3000',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 3000,
  protocol: 'http',
  kind: 'workspace',
  owner: {
    worktreeId: WORKTREE_ID,
    repoId: 'repo',
    displayName: 'app',
    path: '/srv/app',
    confidence: 'cwd'
  }
}

function managedSshState(capabilities: readonly string[]) {
  return {
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: HOST_ID,
    settings: { browserClientHostedRemoteEnabled: true },
    repos: [{ id: 'repo', executionHostId: HOST_ID, connectionId: null }],
    worktreesByRepo: {
      repo: [
        {
          id: WORKTREE_ID,
          repoId: 'repo',
          hostId: HOST_ID,
          runtimeOwnerEnvironmentId: ENVIRONMENT_ID
        }
      ]
    },
    runtimeEnvironments: [
      {
        id: ENVIRONMENT_ID,
        orcadDeployment: {
          kind: 'ssh' as const,
          sshTargetId: 'ssh-target',
          sshTargetGeneration: 1,
          localPort: 2222,
          remotePort: 22
        }
      }
    ],
    runtimeStatusByEnvironmentId: new Map([
      [ENVIRONMENT_ID, { status: { capabilities: [...capabilities], deviceScope: 'desktop' } }]
    ])
  }
}

function routeParts(state: ReturnType<typeof managedSshState>) {
  const availability = getWorkspaceClientCreationActionPolicy(state, WORKTREE_ID)['managed-browser']
  const route = resolveWorktreeOperationRoute(state, WORKTREE_ID)
  return { availability, route }
}

describe('openWorkspacePortInBrowser on a managed SSH server', () => {
  const createBrowserTab = vi.fn()
  const setRemoteBrowserPageHandle = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.assertCapability.mockRejectedValue(new Error(RUNTIME_BROWSER_UNAVAILABLE_MESSAGE))
    mocks.openWorkspaceBrowserTab.mockResolvedValue('page-desktop')
  })

  it('opens the port on this desktop when the runtime cannot stream', async () => {
    const state = managedSshState(CLIENT_HOST_CAPABILITIES)
    const { availability, route } = routeParts(state)
    expect(runtimeHostsPagesOnThisDesktop(state, ENVIRONMENT_ID)).toBe(false)
    expect(
      isSshDeploymentClientBrowserRoute(state, availability, route, WORKTREE_ID, ENVIRONMENT_ID)
    ).toBe(true)
    mocks.getState.mockReturnValue(state)

    const result = await openWorkspacePortInBrowser({
      port,
      runtimeTarget: { kind: 'environment', environmentId: ENVIRONMENT_ID },
      createBrowserTab,
      setRemoteBrowserPageHandle
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.openWorkspaceBrowserTab).toHaveBeenCalledWith({
      workspaceId: WORKTREE_ID,
      url: 'http://127.0.0.1:3000',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: ENVIRONMENT_ID
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })

  it('keeps the remote tab when that runtime can stream', async () => {
    const state = managedSshState([
      ...CLIENT_HOST_CAPABILITIES,
      BROWSER_SCREENCAST_RUNTIME_CAPABILITY
    ])
    mocks.getState.mockReturnValue(state)
    mocks.assertCapability.mockResolvedValue(undefined)
    mocks.callRuntimeRpc.mockResolvedValue({ browserPageId: 'remote-page' })

    const result = await openWorkspacePortInBrowser({
      port,
      runtimeTarget: { kind: 'environment', environmentId: ENVIRONMENT_ID },
      createBrowserTab,
      setRemoteBrowserPageHandle
    })

    expect(result).toEqual({ ok: true })
    expect(mocks.openWorkspaceBrowserTab).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT_ID },
      'browser.tabCreate',
      { worktree: `id:${WORKTREE_ID}`, url: 'http://127.0.0.1:3000' },
      { timeoutMs: 30_000 }
    )
    expect(createBrowserTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      'http://127.0.0.1:3000',
      expect.objectContaining({
        activate: true,
        browserRuntimeEnvironmentId: ENVIRONMENT_ID
      })
    )
    expect(setRemoteBrowserPageHandle).toHaveBeenCalledWith(expect.any(String), {
      environmentId: ENVIRONMENT_ID,
      remotePageId: 'remote-page'
    })
  })

  it('still reports streaming unavailable when no desktop route exists', async () => {
    const state = managedSshState([])
    state.runtimeEnvironments = []
    mocks.getState.mockReturnValue(state)

    const result = await openWorkspacePortInBrowser({
      port,
      runtimeTarget: { kind: 'environment', environmentId: ENVIRONMENT_ID },
      createBrowserTab,
      setRemoteBrowserPageHandle
    })

    expect(result).toEqual({ ok: false, reason: RUNTIME_BROWSER_UNAVAILABLE_MESSAGE })
    expect(mocks.openWorkspaceBrowserTab).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
