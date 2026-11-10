import { describe, expect, it } from 'vitest'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { trackerSteps } from './CloudSetupBrowserTracker'
import { applySwitchTeamStep } from './CloudSetupSwitchTeam'

const derived: CloudSetupStep[] = [
  { id: 'account', state: 'done' },
  { id: 'plan', state: 'needed', need: 'plan', canFix: true },
  { id: 'agent', state: 'optional' }
]

describe('trackerSteps', () => {
  it('marks the first open row as the browser’s for rows derived from billing', () => {
    expect(trackerSteps(derived, false).map((step) => step.state)).toEqual([
      'done',
      'active',
      'optional'
    ])
  })

  it('passes session rows that already say active, and stopped trips, through', () => {
    const session: CloudSetupStep[] = [
      { id: 'account', state: 'active' },
      { id: 'team', state: 'needed' }
    ]
    expect(trackerSteps(session, false)).toBe(session)
    expect(trackerSteps(derived, true)).toBe(derived)
  })
})

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
