import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import {
  clientReachableAddress,
  resolveClientReachableUrlForPort
} from './workspace-port-client-reachable-url'

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

describe('clientReachableAddress', () => {
  it('reduces a reachable URL to the host:port a row displays', () => {
    expect(clientReachableAddress('http://100.64.1.20:5173')).toBe('100.64.1.20:5173')
    expect(clientReachableAddress('https://100.64.1.20:5173/app')).toBe('100.64.1.20:5173')
  })

  it('keeps IPv6 hosts bracketed so the row stays copy-pasteable', () => {
    expect(clientReachableAddress('http://[2001:db8::1]:5173')).toBe('[2001:db8::1]:5173')
  })

  it('returns null for nothing to show, so callers keep the OS-derived address', () => {
    expect(clientReachableAddress(null)).toBeNull()
    expect(clientReachableAddress('not a url')).toBeNull()
  })
})
