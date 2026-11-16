import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace/ports/workspace-ports'

const WORKTREE_ID = 'repo::/srv/app'
const ENVIRONMENT_ID = 'env-ssh'
const HOST_ID = 'runtime:env-ssh'
const URL = 'http://127.0.0.1:3000'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn(),
  createBrowserTab: vi.fn()
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertCapability
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

import { openWorkspacePortInBrowser } from './workspace-port-actions'

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

function managedSshState(capabilities: string[]) {
  return {
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: HOST_ID,
    settings: {},
    createBrowserTab: mocks.createBrowserTab,
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
          kind: 'ssh',
          sshTargetId: 'ssh-target',
          sshTargetGeneration: 1,
          localPort: 2222,
          remotePort: 22
        }
      }
    ],
    runtimeStatusByEnvironmentId: new Map([
      [ENVIRONMENT_ID, { status: { capabilities, deviceScope: 'desktop' } }]
    ])
  }
}

function openPort() {
  return openWorkspacePortInBrowser({
    port,
    runtimeTarget: { kind: 'environment', environmentId: ENVIRONMENT_ID },
    createBrowserTab: mocks.createBrowserTab,
    setRemoteBrowserPageHandle: vi.fn()
  })
}

describe('openWorkspacePortInBrowser on a managed SSH server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.assertCapability.mockRejectedValue(new Error('browser streaming unavailable'))
    mocks.callRuntimeRpc.mockResolvedValue({ browserPageId: 'remote-page' })
    mocks.createBrowserTab.mockReturnValue({ activePageId: 'page-1' })
  })

  it('opens the port in a desktop tab when the server cannot stream', async () => {
    mocks.getState.mockReturnValue(managedSshState(['browser.clientHost.v1']))

    await expect(openPort()).resolves.toEqual({ ok: true })

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      URL,
      expect.objectContaining({ browserRuntimeEnvironmentId: null, executionHostId: HOST_ID })
    )
  })

  it('keeps the server-streamed tab when the server can stream', async () => {
    mocks.getState.mockReturnValue(managedSshState(['browser.screencast.v1']))
    mocks.assertCapability.mockResolvedValue(undefined)

    await expect(openPort()).resolves.toEqual({ ok: true })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENVIRONMENT_ID },
      'browser.tabCreate',
      { worktree: `id:${WORKTREE_ID}`, url: URL },
      { timeoutMs: 30_000 }
    )
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      WORKTREE_ID,
      URL,
      expect.objectContaining({ browserRuntimeEnvironmentId: ENVIRONMENT_ID })
    )
  })
})
