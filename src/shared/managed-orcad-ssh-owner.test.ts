import { describe, expect, it } from 'vitest'
import {
  getLegacyManagedOrcadOwnerEnvironmentId,
  getManagedOrcadFenceEnvironmentId,
  isEphemeralRuntimeSshOwner
} from './managed-orcad-ssh-owner'

describe('managed orcad SSH fence', () => {
  it('reads the fence from orcadFence, never from owner', () => {
    expect(getManagedOrcadFenceEnvironmentId({ orcadFence: { environmentId: 'env-1' } })).toBe(
      'env-1'
    )
    expect(getManagedOrcadFenceEnvironmentId({})).toBeNull()
    expect(getManagedOrcadFenceEnvironmentId(undefined)).toBeNull()
  })

  it('recognises the legacy owner fence only so loading can migrate it', () => {
    const legacy = { type: 'on-demand-runtime' as const, runtimeId: 'managed-orcad:env-1' }
    expect(getLegacyManagedOrcadOwnerEnvironmentId(legacy)).toBe('env-1')
    expect(isEphemeralRuntimeSshOwner(legacy)).toBe(false)
  })

  it('keeps ordinary on-demand runtime targets ephemeral', () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }
    expect(getLegacyManagedOrcadOwnerEnvironmentId(owner)).toBeNull()
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(true)
  })
})
