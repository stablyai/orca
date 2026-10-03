import { describe, expect, it } from 'vitest'
import { isWildcardBindHost, type WorkspacePort } from '../../../shared/workspace-ports'
import { clientReachableBrowserUrlForPort } from './workspace-port-urls'

const TAILNET_ENDPOINT = 'ws://100.64.1.20:6768'

type WorkspaceKindPort = Extract<WorkspacePort, { kind: 'workspace' }>

function workspacePort(overrides: Partial<WorkspaceKindPort> = {}): WorkspaceKindPort {
  return {
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
    },
    ...overrides
  }
}

describe('isWildcardBindHost', () => {
  it('accepts every wildcard the scanners report, however it is written', () => {
    expect(isWildcardBindHost('0.0.0.0')).toBe(true)
    expect(isWildcardBindHost('::')).toBe(true)
    expect(isWildcardBindHost('*')).toBe(true)
    // Normalization inherited from the main-process predicate this one replaced.
    expect(isWildcardBindHost('[::]')).toBe(true)
    expect(isWildcardBindHost(' 0.0.0.0 ')).toBe(true)
  })

  it('rejects loopback and concrete binds', () => {
    expect(isWildcardBindHost('127.0.0.1')).toBe(false)
    expect(isWildcardBindHost('::1')).toBe(false)
    expect(isWildcardBindHost('192.168.1.5')).toBe(false)
    expect(isWildcardBindHost('')).toBe(false)
  })
})

describe('clientReachableBrowserUrlForPort', () => {
  it('substitutes the address this client already reaches the runtime on', () => {
    expect(clientReachableBrowserUrlForPort(workspacePort(), TAILNET_ENDPOINT)).toBe(
      'http://100.64.1.20:5173'
    )
  })

  it('refuses a loopback-bound listener, which no address can reach', () => {
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ bindHost: '127.0.0.1', connectHost: '127.0.0.1' }),
        TAILNET_ENDPOINT
      )
    ).toBeNull()
  })

  it('refuses an ssh-tunnelled endpoint that terminates on this client', () => {
    expect(clientReachableBrowserUrlForPort(workspacePort(), 'ws://127.0.0.1:6768')).toBeNull()
    expect(clientReachableBrowserUrlForPort(workspacePort(), 'ws://localhost:6768')).toBeNull()
  })

  it('refuses a missing or unparseable endpoint instead of guessing', () => {
    expect(clientReachableBrowserUrlForPort(workspacePort(), null)).toBeNull()
    expect(clientReachableBrowserUrlForPort(workspacePort(), '')).toBeNull()
    expect(clientReachableBrowserUrlForPort(workspacePort(), 'not a url')).toBeNull()
  })

  it('keeps the scheme the dev server advertised, replacing only its loopback host', () => {
    // advertisedUrl is origin-only by construction (AdvertisedUrl.origin), so the result
    // is an origin too — no trailing-slash artifact from URL.toString().
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ advertisedUrl: 'https://localhost:5173' }),
        TAILNET_ENDPOINT
      )
    ).toBe('https://100.64.1.20:5173')
  })

  it('leaves an advertised DNS origin alone, because an IP breaks TLS and Host routing', () => {
    // `local.example.com` is the name the certificate is issued for and the name any
    // vhost or reverse proxy keys on. Substituting 100.64.1.20 is strictly worse whenever
    // the name resolves, and a coin flip when it does not.
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ advertisedUrl: 'https://local.example.com:3001', port: 3001 }),
        TAILNET_ENDPOINT
      )
    ).toBe('https://local.example.com:3001')
  })

  it('substitutes for a *.localhost advertised origin, which names the client, not the host', () => {
    // `feature.localhost` resolves to this machine's own loopback, so passing it through
    // would open whatever the laptop runs on 5173 while claiming to reach the remote.
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ advertisedUrl: 'http://feature.localhost:5173' }),
        TAILNET_ENDPOINT
      )
    ).toBe('http://100.64.1.20:5173')
  })

  it('refuses a path-bearing endpoint, whose hostname names a gateway and not the host', () => {
    // parseHostAccessLink allows a path, so a pairing routed through a reverse proxy at
    // wss://gw.example.com/orca/ws yields a hostname that says nothing about port 5173.
    expect(
      clientReachableBrowserUrlForPort(workspacePort(), 'wss://gw.example.com/orca/ws')
    ).toBeNull()
    expect(clientReachableBrowserUrlForPort(workspacePort(), 'wss://gw.example.com/')).toBe(
      'http://gw.example.com:5173'
    )
  })

  it('falls back to the OS-derived shape when the advertised origin will not parse', () => {
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({
          advertisedUrl: 'http://[not a url',
          protocol: 'https'
        }),
        TAILNET_ENDPOINT
      )
    ).toBe('https://100.64.1.20:5173')
  })

  it('brackets an IPv6 endpoint exactly once', () => {
    // Regression: URL reports IPv6 hostnames already bracketed, so re-bracketing
    // produces `[[::1]]`, and assigning a bare IPv6 back silently keeps the old host.
    expect(clientReachableBrowserUrlForPort(workspacePort(), 'ws://[2001:db8::1]:6768')).toBe(
      'http://[2001:db8::1]:5173'
    )
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ advertisedUrl: 'http://localhost:5173' }),
        'ws://[2001:db8::1]:6768'
      )
    ).toBe('http://[2001:db8::1]:5173')
  })

  it('reaches a container port on a wildcard bind, which has no advertised origin', () => {
    expect(
      clientReachableBrowserUrlForPort(
        {
          kind: 'container',
          id: '0.0.0.0:8080:2',
          bindHost: '0.0.0.0',
          connectHost: 'localhost',
          port: 8080,
          protocol: 'http'
        },
        TAILNET_ENDPOINT
      )
    ).toBe('http://100.64.1.20:8080')
  })
})
