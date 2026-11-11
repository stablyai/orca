import { describe, expect, it } from 'vitest'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { applySwitchTeamStep } from './CloudSetupSwitchTeam'

const derived: CloudSetupStep[] = [
  { id: 'account', state: 'done' },
  { id: 'plan', state: 'needed', need: 'plan', canFix: true },
  { id: 'agent', state: 'optional' }
]

describe('applySwitchTeamStep', () => {
  const team: CloudSetupStep = { id: 'team', state: 'needed', detail: 'acme has a Team plan.' }

  it('puts the Team row in place of an open plan row for a signed-in account', () => {
    expect(applySwitchTeamStep(derived, team)?.map((step) => step.id)).toEqual([
      'account',
      'team',
      'agent'
    ])
  })

  it('does nothing when signed out or the account can already start', () => {
    expect(
      applySwitchTeamStep(
        [
          { id: 'account', state: 'needed', need: 'sign-in' },
          { id: 'plan', state: 'pending' }
        ],
        team
      )
    ).toBeNull()
    expect(
      applySwitchTeamStep(
        [
          { id: 'account', state: 'done' },
          { id: 'plan', state: 'done' }
        ],
        team
      )
    ).toBeNull()
  })
})
