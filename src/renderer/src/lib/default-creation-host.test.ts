import { describe, expect, it } from 'vitest'
import { defaultCreationHost } from './default-creation-host'

describe('defaultCreationHost', () => {
  it('is this computer unless a server is chosen', () => {
    expect(defaultCreationHost(null)).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: null })).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: ' env-a ' })).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })
})
