import { describe, expect, it } from 'vitest'
import { GoogleSignInStartParams } from '../../../../../shared/rpc-contract/google-params'
import { googleSignInChoices } from './google-account-readiness'

const account = (services: { service: 'gmail' | 'calendar'; state: 'ready' }[]) => ({
  email: 'dana@acme.com',
  status: 'reconnect' as const,
  services,
  connectedAt: 0
})

describe('what a sign-in asks Google for', () => {
  it('asks for every service for an account this host cannot read, which the host accepts', () => {
    const services = googleSignInChoices(account([]))
    expect(services).toEqual(['gmail', 'calendar', 'files'])
    expect(GoogleSignInStartParams.safeParse({ services }).success).toBe(true)
  })

  it("keeps the account's own services, and asks for all with no account", () => {
    expect(googleSignInChoices(account([{ service: 'calendar', state: 'ready' }]))).toEqual([
      'calendar'
    ])
    expect(googleSignInChoices(undefined)).toEqual(['gmail', 'calendar', 'files'])
  })
})
