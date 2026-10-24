import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDshHomeDir, resolveDshSessionsDir } from './dsh-session-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveDshHomeDir', () => {
  it('honours an absolute DSH_HOME', () => {
    expect(resolveDshHomeDir({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh')
  })

  it('falls back to ~/.dsh when DSH_HOME is unset, blank or relative', () => {
    const fallback = join(homedir(), '.dsh')
    expect(resolveDshHomeDir({})).toBe(fallback)
    expect(resolveDshHomeDir({ DSH_HOME: '  ' })).toBe(fallback)
    // A relative value would resolve against whichever Orca process reads it.
    expect(resolveDshHomeDir({ DSH_HOME: 'dsh-state' })).toBe(fallback)
  })
})

describe('resolveDshSessionsDir', () => {
  it('nests sessions under DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '/srv/dsh')
    expect(resolveDshSessionsDir()).toBe(join('/srv/dsh', 'sessions'))
  })

  it('prefers an explicit scanner override', () => {
    vi.stubEnv('DSH_HOME', '/srv/dsh')
    expect(resolveDshSessionsDir(' /tmp/scan-root ')).toBe('/tmp/scan-root')
  })
})
