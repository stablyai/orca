import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { resolveClientReachableUrlForLoopbackLink } from './workspace-port-urls'

const ENV_ID = 'env-1'
const SCAN_KEY = `environment:${ENV_ID}:all`

function environment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: ENV_ID,
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

function port(overrides: Partial<Extract<WorkspacePort, { kind: 'workspace' }>> = {}) {
  return {
    kind: 'workspace' as const,
    id: '0.0.0.0:5173:1',
    bindHost: '0.0.0.0',
    connectHost: 'localhost',
    port: 5173,
    protocol: 'http' as const,
    owner: {
      worktreeId: 'repo-1:feature',
      repoId: 'repo-1',
      displayName: 'feature',
      path: '/srv/work/feature',
      confidence: 'cwd' as const
    },
    ...overrides
  }
}

function scans(...ports: WorkspacePort[]): Record<string, WorkspacePortScanResult> {
  return { [SCAN_KEY]: { platform: 'linux', scannedAt: 0, ports } }
}

function state(
  overrides: Partial<Parameters<typeof resolveClientReachableUrlForLoopbackLink>[0]> = {}
) {
  return {
    runtimeEnvironments: [environment()],
    workspacePortScansByKey: scans(port()),
    ...overrides
  }
}

describe('resolveClientReachableUrlForLoopbackLink', () => {
  it('rewrites a loopback link a remote pane printed', () => {
    expect(resolveClientReachableUrlForLoopbackLink(state(), 'http://localhost:5173', ENV_ID)).toBe(
      'http://100.64.1.20:5173/'
    )
  })

  it('keeps the path, query and fragment the link carried', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(
        state(),
        'http://127.0.0.1:5173/app?tab=2#top',
        ENV_ID
      )
    ).toBe('http://100.64.1.20:5173/app?tab=2#top')
  })

  it('refuses when the listener behind that port is loopback-bound', () => {
    // The whole reason the scan is consulted: the URL text alone cannot tell us this.
    expect(
      resolveClientReachableUrlForLoopbackLink(
        state({ workspacePortScansByKey: scans(port({ bindHost: '127.0.0.1' })) }),
        'http://localhost:5173',
        ENV_ID
      )
    ).toBeNull()
  })

  it('refuses when no scan has attributed that port yet', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(
        state({ workspacePortScansByKey: scans(port({ port: 4321 })) }),
        'http://localhost:5173',
        ENV_ID
      )
    ).toBeNull()
    expect(
      resolveClientReachableUrlForLoopbackLink(
        state({ workspacePortScansByKey: {} }),
        'http://localhost:5173',
        ENV_ID
      )
    ).toBeNull()
  })

  it('leaves a link that already names a real host alone', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(state(), 'https://example.com/docs', ENV_ID)
    ).toBeNull()
    expect(
      resolveClientReachableUrlForLoopbackLink(state(), 'http://100.64.1.20:5173', ENV_ID)
    ).toBeNull()
  })

  it('refuses an ssh-tunnelled pairing, whose endpoint terminates on this client', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(
        state({ runtimeEnvironments: [environment({ connectionDependency: 'ssh-tunnel' })] }),
        'http://localhost:5173',
        ENV_ID
      )
    ).toBeNull()
  })

  it('refuses an unknown environment rather than guessing a host', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(state(), 'http://localhost:5173', 'env-missing')
    ).toBeNull()
  })

  it('refuses a non-http scheme', () => {
    expect(
      resolveClientReachableUrlForLoopbackLink(state(), 'ws://localhost:5173', ENV_ID)
    ).toBeNull()
  })
})
