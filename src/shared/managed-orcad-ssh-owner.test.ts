import { describe, expect, it } from 'vitest'
import {
  createManagedOrcadSshOwner,
  getManagedOrcadOwnerEnvironmentId,
  isEphemeralRuntimeSshOwner
} from './managed-orcad-ssh-owner'

describe('managed orcad SSH ownership', () => {
  it('writes a marker that older clients keep hidden as an internal target', () => {
    const owner = createManagedOrcadSshOwner('environment-1')

    expect(owner).toEqual({
      type: 'on-demand-runtime',
      runtimeId: 'managed-orcad:environment-1'
    })
    expect(getManagedOrcadOwnerEnvironmentId(owner)).toBe('environment-1')
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(false)
  })

  it('reads the draft owner shape without treating it as an ephemeral VM', () => {
    const owner = { type: 'orcad-runtime' as const, environmentId: 'environment-1' }

    expect(getManagedOrcadOwnerEnvironmentId(owner)).toBe('environment-1')
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(false)
  })

  it('keeps ordinary on-demand runtime targets ephemeral', () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }

    expect(getManagedOrcadOwnerEnvironmentId(owner)).toBeNull()
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(true)
  })
})
