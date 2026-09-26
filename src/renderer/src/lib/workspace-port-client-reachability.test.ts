import { describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WorkspacePort } from '../../../shared/workspace-ports'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))

// Why mocked: the worktree -> execution-host lookup walks the whole store graph. These
// tests are about which host a *port* resolves to, so the worktree answer is pinned and
// only the port's own scan key varies.
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))

const { resolveClientReachableUrlForPort, resolvePortClientReachability } =
  await import('./workspace-port-client-reachability')

const PORT: WorkspacePort = {
  kind: 'workspace',
  id: '0.0.0.0:5173:1',
  bindHost: '0.0.0.0',
  connectHost: 'localhost',
  port: 5173,
  protocol: 'http',
  owner: {
    worktreeId: 'repo-1:feature',
    repoId: 'repo-1',
    displayName: 'feature',
    path: '/srv/work/feature',
    confidence: 'cwd'
  }
}

function environment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'vps',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: 'runtime-1',
    preferredEndpointId: 'ws-primary',
    endpoints: [
      { id: 'ws-primary', kind: 'websocket', label: 'Tailscale', endpoint: 'ws://100.64.1.20:6768' }
    ],
    ...overrides
  }
}

describe('resolveClientReachableUrlForPort', () => {
  it('rewrites the host for a paired runtime workspace', () => {
    expect(
      resolveClientReachableUrlForPort({ runtimeEnvironments: [environment()] }, PORT, {
        kind: 'environment',
        environmentId: 'env-1'
      })
    ).toBe('http://100.64.1.20:5173')
  })

  it('returns null for a local target, whose ports are already on this machine', () => {
    expect(
      resolveClientReachableUrlForPort({ runtimeEnvironments: [environment()] }, PORT, {
        kind: 'local'
      })
    ).toBeNull()
    expect(
      resolveClientReachableUrlForPort({ runtimeEnvironments: [environment()] }, PORT, null)
    ).toBeNull()
  })

  it('returns null when the environment is not in the catalog', () => {
    expect(
      resolveClientReachableUrlForPort({ runtimeEnvironments: [environment()] }, PORT, {
        kind: 'environment',
        environmentId: 'env-missing'
      })
    ).toBeNull()
    expect(
      resolveClientReachableUrlForPort({}, PORT, { kind: 'environment', environmentId: 'env-1' })
    ).toBeNull()
  })

  it('refuses an ssh-tunnelled pairing even when its endpoint looks routable', () => {
    expect(
      resolveClientReachableUrlForPort(
        {
          runtimeEnvironments: [
            environment({
              connectionDependency: 'ssh-tunnel',
              endpoints: [
                {
                  id: 'ws-primary',
                  kind: 'websocket',
                  label: 'Tunnel',
                  endpoint: 'ws://100.64.1.20:6768'
                }
              ]
            })
          ]
        },
        PORT,
        { kind: 'environment', environmentId: 'env-1' }
      )
    ).toBeNull()
  })

  it('uses the preferred endpoint rather than the first one listed', () => {
    expect(
      resolveClientReachableUrlForPort(
        {
          runtimeEnvironments: [
            environment({
              preferredEndpointId: 'ws-tailnet',
              endpoints: [
                {
                  id: 'ws-lan',
                  kind: 'websocket',
                  label: 'LAN',
                  endpoint: 'ws://192.168.1.5:6768'
                },
                {
                  id: 'ws-tailnet',
                  kind: 'websocket',
                  label: 'Tailscale',
                  endpoint: 'ws://100.64.1.20:6768'
                }
              ]
            })
          ]
        },
        PORT,
        { kind: 'environment', environmentId: 'env-1' }
      )
    ).toBe('http://100.64.1.20:5173')
  })

  it('falls back to the first endpoint when the preferred id is stale', () => {
    expect(
      resolveClientReachableUrlForPort(
        { runtimeEnvironments: [environment({ preferredEndpointId: 'ws-removed' })] },
        PORT,
        { kind: 'environment', environmentId: 'env-1' }
      )
    ).toBe('http://100.64.1.20:5173')
  })
})

describe('resolvePortClientReachability', () => {
  const state = { activeWorktreeId: 'repo-1:feature', runtimeEnvironments: [environment()] }

  it('reduces the reachable URL to the host:port a row displays and copies', () => {
    const reachability = resolvePortClientReachability(state, {
      ...PORT,
      hostScanKey: 'environment:env-1:all'
    })
    expect(reachability.reachableUrl).toBe('http://100.64.1.20:5173')
    expect(reachability.address).toBe('100.64.1.20:5173')
    expect(reachability.remoteHost).toBe(true)
    expect(reachability.systemBrowserAvailable).toBe(true)
  })

  it('keeps the port on a default-port listener, which URL.host would drop', () => {
    // A row that reads a bare `100.64.1.20` next to rows that read `host:port` looks like
    // a different kind of thing; the listener's own port is the honest one to show.
    const reachability = resolvePortClientReachability(state, {
      ...PORT,
      hostScanKey: 'environment:env-1:all',
      port: 80,
      advertisedUrl: 'http://localhost'
    })
    expect(reachability.address).toBe('100.64.1.20:80')
  })

  it('keeps an IPv6 host bracketed so the row stays copy-pasteable', () => {
    const reachability = resolvePortClientReachability(
      {
        ...state,
        runtimeEnvironments: [
          environment({
            endpoints: [
              {
                id: 'ws-primary',
                kind: 'websocket',
                label: 'Tailscale',
                endpoint: 'ws://[2001:db8::1]:6768'
              }
            ]
          })
        ]
      },
      { ...PORT, hostScanKey: 'environment:env-1:all' }
    )
    expect(reachability.address).toBe('[2001:db8::1]:5173')
  })

  it('resolves a merged row against the host that reported it, not the active workspace', () => {
    // Regression: the status bar renders the merged all-hosts scan, so a *local*
    // 0.0.0.0 listener sat next to remote rows. Falling back to the active workspace's
    // host stamped it with a remote machine's address, naming whatever that host runs on
    // the same port.
    const localExternalPort: WorkspacePort = {
      kind: 'external',
      id: 'local:all:0.0.0.0:7000',
      hostScanKey: 'local:all',
      bindHost: '0.0.0.0',
      connectHost: 'localhost',
      port: 7000,
      protocol: 'http'
    }
    const remoteState = {
      activeWorktreeId: 'repo-1:feature',
      runtimeEnvironments: [environment()]
    }
    expect(resolvePortClientReachability(remoteState, localExternalPort)).toMatchObject({
      runtimeTarget: { kind: 'local' },
      reachableUrl: null,
      address: 'localhost:7000',
      systemBrowserAvailable: true
    })

    const remoteExternalPort: WorkspacePort = {
      ...localExternalPort,
      id: 'environment:env-1:all:0.0.0.0:7000',
      hostScanKey: 'environment:env-1:all'
    }
    expect(resolvePortClientReachability(remoteState, remoteExternalPort)).toMatchObject({
      runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
      address: '100.64.1.20:7000'
    })
  })

  it('falls back to the OS-derived address when no reachable URL exists', () => {
    const loopbackPort: WorkspacePort = {
      ...PORT,
      hostScanKey: 'environment:env-1:all',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1'
    }
    expect(resolvePortClientReachability(state, loopbackPort)).toMatchObject({
      reachableUrl: null,
      address: '127.0.0.1:5173',
      // A remote loopback-bound port has no address any browser on this machine can open.
      systemBrowserAvailable: false
    })
  })
})
