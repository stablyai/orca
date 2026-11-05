import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import {
  reconcileLinearTeamSelection,
  storedLinearTeamSelection
} from './task-page-linear-team-selection'

function team(id: string): LinearTeam {
  return {
    id,
    name: id,
    key: id.toUpperCase()
  }
}

describe('reconcileLinearTeamSelection', () => {
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

  // Persisted strings pass Set construction but crash array filtering; malformed selections must resolve to sticky-all.
  it('treats a saved selection of the wrong shape as sticky-all', () => {
    expect(Array.from(reconcileLinearTeamSelection([team('a'), team('b')], 'a'))).toEqual([
      'a',
      'b'
    ])
    expect(Array.from(reconcileLinearTeamSelection([team('a'), team('b')], { 0: 'a' }))).toEqual([
      'a',
      'b'
    ])
  })
})

describe('storedLinearTeamSelection', () => {
  it('drops non-string entries from a mixed array', () => {
    expect(storedLinearTeamSelection(['a', 1, null, 'b'])).toEqual(['a', 'b'])
  })
})
