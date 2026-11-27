import { describe, expect, it } from 'vitest'
import { managedServerOutcomeLabel } from './managed-server-copy'

const t = (key: string) => key

describe('managedServerOutcomeLabel', () => {
  it('names a held host even when Stop reports it as unverifiable', () => {
    expect(
      managedServerOutcomeLabel(
        {
          outcome: 'refused',
          code: 'orcad_activation_recovery_required',
          verdict: 'unverifiable'
        },
        t
      )
    ).toBe('auto.components.settings.managedServers.outcome.recoveryRequired')
  })
})
