import { describe, expect, it } from 'vitest'
import { RelayPhoneHelloSchema } from './mobile-relay-phone-protocol'

describe('relay phone outer protocol', () => {
  it('accepts only exact invite, resume, and failure hello variants', () => {
    expect(
      RelayPhoneHelloSchema.safeParse({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'invite',
        leaseExpiresAt: 1
      }).success
    ).toBe(true)
    expect(
      RelayPhoneHelloSchema.safeParse({
        type: 'relay-hello',
        ok: false,
        code: 4404,
        cellUrl: 'https://untrusted.example'
      }).success
    ).toBe(false)
    expect(
      RelayPhoneHelloSchema.safeParse({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'resume',
        leaseExpiresAt: 10,
        acceptedCredentialVersion: 2,
        acceptedAs: 'grace',
        resumeExpiresAt: 8
      }).success
    ).toBe(true)
  })
})
