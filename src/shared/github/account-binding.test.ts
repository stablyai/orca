import { describe, expect, it } from 'vitest'
import {
  ghAccountBindingsEqual,
  ghTokenEnvVarForHost,
  normalizeGhAccountBinding
} from './account-binding'

describe('normalizeGhAccountBinding', () => {
  it('trims, lowercases host, and preserves user case', () => {
    expect(normalizeGhAccountBinding({ host: ' GitHub.COM ', user: ' Alice ' })).toEqual({
      host: 'github.com',
      user: 'Alice'
    })
  })

  it('rejects malformed shapes', () => {
    expect(normalizeGhAccountBinding(null)).toBeNull()
    expect(normalizeGhAccountBinding({ host: '', user: 'a' })).toBeNull()
    expect(normalizeGhAccountBinding({ host: 'github.com', user: '' })).toBeNull()
    expect(normalizeGhAccountBinding({ host: 'bad host', user: 'a' })).toBeNull()
    expect(normalizeGhAccountBinding({ host: 'github.com', user: 'has space' })).toBeNull()
  })

  it('accepts GHES/LDAP logins with underscores and dots', () => {
    expect(normalizeGhAccountBinding({ host: 'github.acme.com', user: 'svc_build' })).toEqual({
      host: 'github.acme.com',
      user: 'svc_build'
    })
    expect(normalizeGhAccountBinding({ host: 'github.acme.com', user: 'first.last' })).toEqual({
      host: 'github.acme.com',
      user: 'first.last'
    })
  })
})

describe('ghTokenEnvVarForHost', () => {
  it('selects GH_TOKEN for github.com, github.localhost, and *.ghe.com', () => {
    expect(ghTokenEnvVarForHost('github.com')).toBe('GH_TOKEN')
    expect(ghTokenEnvVarForHost('github.localhost')).toBe('GH_TOKEN')
    expect(ghTokenEnvVarForHost('acme.ghe.com')).toBe('GH_TOKEN')
  })

  it('selects GH_ENTERPRISE_TOKEN for classic GHES hosts', () => {
    expect(ghTokenEnvVarForHost('github.acme-corp.com')).toBe('GH_ENTERPRISE_TOKEN')
    expect(ghTokenEnvVarForHost('ghe.internal')).toBe('GH_ENTERPRISE_TOKEN')
  })
})

describe('ghAccountBindingsEqual', () => {
  it('compares normalized host/user pairs', () => {
    expect(
      ghAccountBindingsEqual(
        { host: 'github.com', user: 'Alice' },
        { host: 'github.com', user: 'Alice' }
      )
    ).toBe(true)
    expect(
      ghAccountBindingsEqual(
        { host: 'github.com', user: 'Alice' },
        { host: 'github.com', user: 'alice' }
      )
    ).toBe(false)
  })
})
