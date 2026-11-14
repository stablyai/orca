import { describe, expect, it } from 'vitest'
import { ghTokenEnvVarForHost } from './account-binding'

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
