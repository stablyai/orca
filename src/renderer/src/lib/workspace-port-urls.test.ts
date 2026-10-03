import { describe, expect, it } from 'vitest'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import { getPortOpenBrowserTooltipLabel } from './workspace-port-actions'
import { clientReachableBrowserUrlForPort, isWildcardBindHost } from './workspace-port-urls'

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
  it('accepts every wildcard the scanners report', () => {
    expect(isWildcardBindHost('0.0.0.0')).toBe(true)
    expect(isWildcardBindHost('::')).toBe(true)
    expect(isWildcardBindHost('*')).toBe(true)
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

  it('keeps the scheme and path the dev server advertised, replacing only the host', () => {
    expect(
      clientReachableBrowserUrlForPort(
        workspacePort({ advertisedUrl: 'https://localhost:5173/app' }),
        TAILNET_ENDPOINT
      )
    ).toBe('https://100.64.1.20:5173/app')
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
        workspacePort({ advertisedUrl: 'http://localhost:5173/app' }),
        'ws://[2001:db8::1]:6768'
      )
    ).toBe('http://[2001:db8::1]:5173/app')
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

describe('getPortOpenBrowserTooltipLabel', () => {
  it('advertises the modifier when the system browser can serve the port', () => {
    expect(getPortOpenBrowserTooltipLabel('Open in Browser', true)).toContain('for system browser')
    expect(getPortOpenBrowserTooltipLabel('Open in Browser', true, true)).toContain(
      'for system browser'
    )
  })

  it('drops the hint when no reachable address exists, rather than promising a no-op', () => {
    // A remote loopback-bound port cannot be opened externally at any URL, so the
    // modifier would silently fall through to the in-app browser.
    expect(getPortOpenBrowserTooltipLabel('Open in Browser', true, false)).toBe('Open in Browser')
  })
})
