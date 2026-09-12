import { expect, it } from 'vitest'
import {
  OrcadManagedStopAuthoritySchema,
  sameOrcadManagedStopAuthority
} from './orcad-managed-stop-authority'

const authority = {
  runtimeId: 'runtime',
  profileId: 'profile',
  profileRoot: 'host-profile-root',
  transactionId: '11111111-1111-4111-8111-111111111111'
}

it('parses the concrete authority and ignores additive wire fields', () => {
  expect(OrcadManagedStopAuthoritySchema.parse({ ...authority, future: true })).toEqual(authority)
  expect(sameOrcadManagedStopAuthority(authority, { ...authority })).toBe(true)
})

it.each(['runtimeId', 'profileId', 'profileRoot', 'transactionId'] as const)(
  'requires and compares %s',
  (field) => {
    expect(OrcadManagedStopAuthoritySchema.safeParse({ ...authority, [field]: '' }).success).toBe(
      false
    )
    expect(
      OrcadManagedStopAuthoritySchema.safeParse({ ...authority, [field]: undefined }).success
    ).toBe(false)
    expect(sameOrcadManagedStopAuthority(authority, { ...authority, [field]: 'different' })).toBe(
      false
    )
  }
)

it('rejects malformed transaction identity', () => {
  expect(
    OrcadManagedStopAuthoritySchema.safeParse({ ...authority, transactionId: 'stop-1' }).success
  ).toBe(false)
})
