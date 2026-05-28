import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../shared/types'
import { reconcileLinearTeamSelection } from './task-page-linear-team-selection'

function team(id: string): LinearTeam {
  return {
    id,
    name: id,
    key: id.toUpperCase()
  }
}

describe('reconcileLinearTeamSelection', () => {
  it('selects every available team when the saved selection is sticky-all', () => {
    expect(Array.from(reconcileLinearTeamSelection([team('a'), team('b')], null))).toEqual([
      'a',
      'b'
    ])
  })

  it('preserves saved teams that still exist', () => {
    expect(Array.from(reconcileLinearTeamSelection([team('a'), team('b')], ['b']))).toEqual(['b'])
  })

  it('drops stale saved teams after switching workspaces', () => {
    expect(Array.from(reconcileLinearTeamSelection([team('c'), team('d')], ['a', 'd']))).toEqual([
      'd'
    ])
  })

  it('falls back to all current teams when every saved team is stale', () => {
    expect(Array.from(reconcileLinearTeamSelection([team('c'), team('d')], ['a', 'b']))).toEqual([
      'c',
      'd'
    ])
  })
})
