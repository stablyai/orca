import { describe, expect, it } from 'vitest'
import { getProviderAccountScope, getProviderRateLimitScope } from './provider-account-scope'

const environmentId = '3f2b8c1e-9a4d-4e7f-b2c6-1d5e8f0a7b39'

describe('provider host scope labels', () => {
  it('names the paired server instead of its environment ID', () => {
    expect(getProviderAccountScope({ kind: 'environment', environmentId }, 'win11').label).toBe(
      'Remote server: win11'
    )
    expect(
      getProviderRateLimitScope({ kind: 'environment', environmentId }, 'win11', 'GitHub').label
    ).toBe('Remote server: win11')
  })

  it('falls back to a bare label when the server name is not loaded', () => {
    expect(getProviderAccountScope({ kind: 'environment', environmentId }, null).label).toBe(
      'Remote server'
    )
    expect(
      getProviderRateLimitScope({ kind: 'environment', environmentId }, '  ', 'GitLab').label
    ).toBe('Remote server')
  })
})
