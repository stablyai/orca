import { describe, expect, it } from 'vitest'
import { fleetTeamLayout } from './fleet-team-fold'

const leaf = { children: [] }

describe('fleetTeamLayout', () => {
  it('folds three workers once the root branch gutter would squeeze them below the readable width', () => {
    const team = { children: [leaf, leaf, leaf] }
    expect(fleetTeamLayout(team, 590)).toBe('outline')
    expect(fleetTeamLayout(team, 602)).toBe('tree')
  })

  it('counts the gutters of every nested branch, not only the leaves', () => {
    const team = { children: [leaf, { children: [leaf, leaf] }] }
    expect(fleetTeamLayout(team, 613)).toBe('outline')
    expect(fleetTeamLayout(team, 614)).toBe('tree')
  })
})
