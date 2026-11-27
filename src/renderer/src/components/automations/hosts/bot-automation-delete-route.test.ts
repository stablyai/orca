import { describe, expect, it } from 'vitest'
import { botAutomationDeleteRoute } from './automation-host-client'

const env = (environmentId: string, pairingRevision: number) =>
  ({ kind: 'environment', environmentId, pairingRevision }) as const

describe('a bot automation delete', () => {
  it('goes only to the incarnation whose read listed it, with that exact revision', () => {
    expect(
      botAutomationDeleteRoute(env('a', 11), { kind: 'environment', environmentId: 'a' })
    ).toEqual({
      target: { kind: 'environment', environmentId: 'a' },
      expectedEnvironmentPairingRevision: 11
    })
    // Zero is a real revision, never "no fence".
    expect(
      botAutomationDeleteRoute(env('a', 0), { kind: 'environment', environmentId: 'a' })
        ?.expectedEnvironmentPairingRevision
    ).toBe(0)
    expect(botAutomationDeleteRoute({ kind: 'local' }, { kind: 'local' })).toEqual({
      target: { kind: 'local' }
    })
  })

  it('is refused when the bot now routes somewhere else', () => {
    expect(
      botAutomationDeleteRoute(env('a', 11), { kind: 'environment', environmentId: 'b' })
    ).toBeNull()
    expect(botAutomationDeleteRoute(env('a', 11), { kind: 'local' })).toBeNull()
    expect(
      botAutomationDeleteRoute({ kind: 'local' }, { kind: 'environment', environmentId: 'a' })
    ).toBeNull()
  })

  it('refuses a delete when the listing had no pairing revision', () => {
    expect(
      botAutomationDeleteRoute(
        { kind: 'environment-unavailable', environmentId: 'a' },
        { kind: 'environment', environmentId: 'a' }
      )
    ).toBeNull()
  })
})
