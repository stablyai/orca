import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
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

  // Why: 0a2b6e7f (1.4.207) crashed page.tasks with "(t ?? []).filter is not a
  // function": the persisted setting reached the renderer as a string, which
  // `new Set(value)` in the hook initializer accepts and this call did not.
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
  it('keeps a string array', () => {
    expect(storedLinearTeamSelection(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('reads null and undefined as sticky-all', () => {
    expect(storedLinearTeamSelection(null)).toBeNull()
    expect(storedLinearTeamSelection(undefined)).toBeNull()
  })

  it('reads a string, an object or a number as sticky-all instead of throwing', () => {
    expect(storedLinearTeamSelection('a')).toBeNull()
    expect(storedLinearTeamSelection({ 0: 'a' })).toBeNull()
    expect(storedLinearTeamSelection(7)).toBeNull()
  })

  it('drops non-string entries from a mixed array', () => {
    expect(storedLinearTeamSelection(['a', 1, null, 'b'])).toEqual(['a', 'b'])
  })
})
