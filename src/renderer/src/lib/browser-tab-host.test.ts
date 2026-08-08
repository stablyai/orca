import { afterEach, describe, expect, it } from 'vitest'
import {
  isBrowserTabHostLockedToWorkspace,
  resolveBrowserTabHost,
  resolveBrowserTabTarget
} from './browser-tab-host'

const webClientFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }
const localRoute = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
} as const
const sshRoute = {
  kind: 'resolved',
  route: { executionHostId: 'ssh:server', runtimeEnvironmentId: null }
} as const
const runtimeRoute = {
  kind: 'resolved',
  route: { executionHostId: 'runtime:env-1', runtimeEnvironmentId: 'env-1' }
} as const

describe('resolveBrowserTabHost', () => {
  afterEach(() => {
    delete webClientFlag.__ORCA_WEB_CLIENT__
  })

  it('defaults desktop clients to local ownership', () => {
    expect(isBrowserTabHostLockedToWorkspace()).toBe(false)
    expect(resolveBrowserTabHost(undefined)).toBe('local')
    expect(resolveBrowserTabTarget('local', { kind: 'missing' })).toEqual({ kind: 'local' })
  })

  it('honors the configured desktop host', () => {
    expect(resolveBrowserTabHost('workspace')).toBe('workspace')
  })

  it('keeps confirmed local and direct SSH desktop workspaces on the local surface', () => {
    expect(resolveBrowserTabTarget('workspace', localRoute)).toEqual({ kind: 'local' })
    expect(resolveBrowserTabTarget('workspace', sshRoute)).toEqual({ kind: 'local' })
  })

  it('resolves confirmed runtime ownership without using the focused host', () => {
    expect(resolveBrowserTabTarget('workspace', runtimeRoute)).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('fails workspace ownership closed when the route is uncertain', () => {
    expect(resolveBrowserTabTarget('workspace', { kind: 'missing' })).toEqual({
      kind: 'unavailable'
    })
    expect(resolveBrowserTabTarget('workspace', { kind: 'ambiguous' })).toEqual({
      kind: 'unavailable'
    })
  })

  it('keeps web clients runtime-owned', () => {
    webClientFlag.__ORCA_WEB_CLIENT__ = true

    expect(isBrowserTabHostLockedToWorkspace()).toBe(true)
    expect(resolveBrowserTabHost('local')).toBe('workspace')
    expect(resolveBrowserTabTarget('local', localRoute)).toEqual({ kind: 'unavailable' })
    expect(resolveBrowserTabTarget('local', runtimeRoute)).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1'
    })
  })
})
