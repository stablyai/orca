import { expect, it } from 'vitest'
import { OrcadManagedStopInstanceSchema } from './orcad-managed-stop-instance'
import { OrcadManagedStopIdentitySchema } from './orcad-managed-decommission'

const instance = { pid: 123, startedAtMs: null, nonce: 'instance-a', lockPath: '/host/orcad.lock' }

it('retains exact instance fields including unavailable start-time evidence', () => {
  expect(OrcadManagedStopInstanceSchema.parse(instance)).toEqual(instance)
})

it.each([
  { pid: 0 },
  { pid: -1 },
  { pid: 1.5 },
  { startedAtMs: -1 },
  { startedAtMs: Infinity },
  { nonce: '' },
  { lockPath: '' }
])('rejects invalid process identity (%j)', (change) => {
  expect(OrcadManagedStopInstanceSchema.safeParse({ ...instance, ...change }).success).toBe(false)
})

it('does not manufacture process evidence when an older identity response omits it', () => {
  const response = {
    version: '0.1.0',
    identity: {
      runtimeId: 'runtime-a',
      profileId: 'profile-a',
      profileRoot: '/host/profile-a'
    }
  }
  expect(OrcadManagedStopIdentitySchema.parse(response).instance).toBeUndefined()
  expect(OrcadManagedStopIdentitySchema.parse({ ...response, instance }).instance).toEqual(instance)
})
