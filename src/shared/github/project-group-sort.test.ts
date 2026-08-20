import { describe, expect, it } from 'vitest'
import { sortRows } from './project-group-sort'
import type { GitHubProjectRow, GitHubProjectTable } from './project-types'

const USERS_FIELD = { id: 'f1', name: 'Assignees', kind: 'users' } as never

function tableSortedBy(direction: 'ASC' | 'DESC'): GitHubProjectTable {
  return {
    selectedView: { groupByFields: [], sortByFields: [{ field: USERS_FIELD, direction }] }
  } as unknown as GitHubProjectTable
}

function rowWithUsers(id: string, logins: string[] | null, position: number): GitHubProjectRow {
  return {
    id,
    position,
    fieldValuesByFieldId: logins
      ? { f1: { kind: 'users', fieldId: 'f1', users: logins.map((login) => ({ login })) } }
      : {}
  } as unknown as GitHubProjectRow
}

const ids = (rows: GitHubProjectRow[]): string[] => rows.map((row) => row.id)

describe('sortRows', () => {
  it('keeps an empty user list last in both directions', () => {
    const rows = [
      rowWithUsers('assigned', ['alice'], 1),
      rowWithUsers('empty-list', [], 2),
      rowWithUsers('no-value', null, 3)
    ]

    expect(ids(sortRows(tableSortedBy('ASC'), rows))).toEqual([
      'assigned',
      'empty-list',
      'no-value'
    ])
    expect(ids(sortRows(tableSortedBy('DESC'), rows))).toEqual([
      'assigned',
      'empty-list',
      'no-value'
    ])
  })

  it('still reverses populated values when sorting DESC', () => {
    const rows = [
      rowWithUsers('alice', ['alice'], 1),
      rowWithUsers('carol', ['carol'], 2),
      rowWithUsers('bob', ['bob'], 3),
      rowWithUsers('empty-list', [], 4)
    ]

    expect(ids(sortRows(tableSortedBy('ASC'), rows))).toEqual([
      'alice',
      'bob',
      'carol',
      'empty-list'
    ])
    expect(ids(sortRows(tableSortedBy('DESC'), rows))).toEqual([
      'carol',
      'bob',
      'alice',
      'empty-list'
    ])
  })

  it('falls through to position when both rows are unassigned', () => {
    const rows = [
      rowWithUsers('second', [], 2),
      rowWithUsers('first', [], 1),
      rowWithUsers('third', null, 3)
    ]

    expect(ids(sortRows(tableSortedBy('DESC'), rows))).toEqual(['first', 'second', 'third'])
  })
})
