import { describe, expect, it } from 'vitest'
import { searchHit } from './ai-vault-search-test-fixture'
import { redactForTransport, redactStatusForTransport } from './ai-vault-search-transport'
import { unavailableSessionSearchStatus } from './ai-vault-search-client'

describe('session search public contract', () => {
  it('withholds source paths and resume commands over relay', () => {
    const result = redactForTransport(searchHit(), 'relay')
    expect(result.source).toEqual({ presence: 'present' })
    expect(result).not.toHaveProperty('resumeCommand')
  })

  it('withholds degraded-root paths and reasons over relay', () => {
    const status = {
      ...unavailableSessionSearchStatus(),
      degradedRoots: [{ root: '/host/projects', reason: 'could not be listed' }]
    }
    expect(redactStatusForTransport(status, 'relay').degradedRoots).toEqual([
      { reason: 'Source root could not be verified.' }
    ])
  })
})
