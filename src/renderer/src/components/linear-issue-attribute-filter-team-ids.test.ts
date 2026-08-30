import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
import {
  capLinearMetadataIdsAcrossGroups,
  expandLinearMetadataGroupKeys,
  groupLinearMetadataByName,
  isLinearMetadataGroupSelectionPartial,
  linearMetadataGroupCoverage,
  resolveLinearIssueAttributeFilterTeamIds,
  selectedLinearMetadataGroupKeys,
  unionLinearMetadataById
} from './linear-issue-attribute-filter-team-ids'

const teams: LinearTeam[] = [
  { id: 'team-be', name: 'Backend', key: 'BE' },
  { id: 'team-fe', name: 'Frontend', key: 'FE' },
  { id: 'team-ops', name: 'Ops', key: 'OPS' }
]

describe('resolveLinearIssueAttributeFilterTeamIds', () => {
  it('returns every selected team in stable name order', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-fe', 'team-be'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-be', 'team-fe'])
  })

  it('returns all selected teams when All teams is selected', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-ops', 'team-be', 'team-fe'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-be', 'team-fe', 'team-ops'])
  })

  it('falls back to primary when selection is empty', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: [],
        availableTeams: teams,
        primaryTeamId: 'team-fe'
      })
    ).toEqual(['team-fe'])
  })

  it('drops ids that are not in availableTeams', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-fe', 'missing'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-fe'])
  })
})

describe('unionLinearMetadataById', () => {
  it('unions options across teams without dropping later teams (#8739)', () => {
    const unioned = unionLinearMetadataById([
      [
        { id: 'be-todo', name: 'Todo' },
        { id: 'be-done', name: 'Done' }
      ],
      [
        { id: 'fe-todo', name: 'Todo' },
        { id: 'fe-review', name: 'In Review' }
      ],
      [{ id: 'ops-blocked', name: 'Blocked' }]
    ])
    expect(unioned.map((row) => row.id)).toEqual([
      'be-todo',
      'be-done',
      'fe-todo',
      'fe-review',
      'ops-blocked'
    ])
  })

  it('dedupes shared ids keeping the first label', () => {
    const unioned = unionLinearMetadataById([
      [{ id: 'shared', name: 'From BE' }],
      [{ id: 'shared', name: 'From FE' }]
    ])
    expect(unioned).toEqual([{ id: 'shared', name: 'From BE' }])
  })
})

describe('groupLinearMetadataByName', () => {
  // Why: Linear workflow states are per team, so "Todo" exists once per selected team (#16785).
  const states = [
    { id: 'be-backlog', name: 'Backlog' },
    { id: 'be-todo', name: 'Todo' },
    { id: 'fe-backlog', name: 'Backlog' },
    { id: 'fe-todo', name: 'Todo' },
    { id: 'fe-review', name: 'In Review' }
  ]

  it('collapses same-named ids into one keyed group in first-seen order', () => {
    expect(groupLinearMetadataByName(states)).toEqual([
      { key: 'be-backlog', name: 'Backlog', ids: ['be-backlog', 'fe-backlog'] },
      { key: 'be-todo', name: 'Todo', ids: ['be-todo', 'fe-todo'] },
      { key: 'fe-review', name: 'In Review', ids: ['fe-review'] }
    ])
  })

  it('marks a group selected when any of its team ids is selected', () => {
    const groups = groupLinearMetadataByName(states)
    expect(selectedLinearMetadataGroupKeys(groups, ['fe-todo'])).toEqual(['be-todo'])
    expect(selectedLinearMetadataGroupKeys(groups, ['be-todo', 'fe-todo'])).toEqual(['be-todo'])
    expect(selectedLinearMetadataGroupKeys(groups, [])).toEqual([])
  })

  it('expands picked group keys back to every team id behind them', () => {
    const groups = groupLinearMetadataByName(states)
    expect(expandLinearMetadataGroupKeys(groups, ['be-todo', 'fe-review'])).toEqual([
      'be-todo',
      'fe-todo',
      'fe-review'
    ])
  })

  // Why: metadata for another team may still be loading; toggling a row must not drop
  // the ids it does not know about yet (R12).
  it('passes ids no group covers through both directions', () => {
    const groups = groupLinearMetadataByName(states)
    expect(selectedLinearMetadataGroupKeys(groups, ['other-team-todo'])).toEqual([
      'other-team-todo'
    ])
    expect(expandLinearMetadataGroupKeys(groups, ['other-team-todo'])).toEqual(['other-team-todo'])
  })
})

describe('capLinearMetadataIdsAcrossGroups', () => {
  const groups = [
    { key: 'alpha', ids: ['a-1', 'a-2', 'a-3'] },
    { key: 'zeta', ids: ['z-1'] }
  ]

  it('leaves a selection already within the cap untouched', () => {
    expect(capLinearMetadataIdsAcrossGroups(groups, ['a-1', 'a-2'], 3)).toEqual(['a-1', 'a-2'])
  })

  // Why: a plain slice of the sorted id list drops the whole trailing group, which then
  // renders unchecked and disappears from the coverage count (#16879).
  it('keeps an id from every picked group instead of slicing the last one away', () => {
    expect(capLinearMetadataIdsAcrossGroups(groups, ['a-1', 'a-2', 'a-3', 'z-1'], 3)).toEqual([
      'a-1',
      'z-1',
      'a-2'
    ])
  })

  it('treats an id no group covers as its own group', () => {
    expect(capLinearMetadataIdsAcrossGroups(groups, ['a-1', 'a-2', 'a-3', 'other'], 2)).toEqual([
      'a-1',
      'other'
    ])
  })
})

describe('capLinearMetadataIdsAcrossGroups over-subscribed rows', () => {
  const singleIdGroups = (count: number): { key: string; ids: string[] }[] =>
    Array.from({ length: count }, (_unused, index) => ({
      key: `s${index}`,
      ids: [`s${index}`]
    }))

  it('leaves a selection sitting exactly on the cap untouched', () => {
    const groups = singleIdGroups(4)
    const ids = groups.flatMap((group) => group.ids)
    expect(capLinearMetadataIdsAcrossGroups(groups, ids, 4)).toEqual(ids)
    // Why: on the cap, full coverage is indistinguishable from a starved row, so coverage
    // warns rather than claim what it cannot prove — below the cap it stays quiet (#17342).
    expect(isLinearMetadataGroupSelectionPartial(groups, ids, 4)).toBe(true)
    expect(isLinearMetadataGroupSelectionPartial(groups, ids, 5)).toBe(false)
  })

  it('keeps one id per row when the selection is one id over the cap', () => {
    const groups = [
      { key: 'alpha', ids: ['a-1', 'a-2'] },
      { key: 'beta', ids: ['b-1'] },
      { key: 'gamma', ids: ['c-1'] }
    ]
    const capped = capLinearMetadataIdsAcrossGroups(groups, ['a-1', 'a-2', 'b-1', 'c-1'], 3)
    expect(new Set(capped)).toEqual(new Set(['a-1', 'b-1', 'c-1']))
  })

  // Why: MultiSelectList.toggle appends the clicked key last, so the starved row was always
  // the row the user just clicked — and coverage still reported a full 100 of 100.
  it('never claims full coverage when more rows are picked than the cap can hold', () => {
    const groups = singleIdGroups(101)
    const ids = groups.flatMap((group) => group.ids)
    const capped = capLinearMetadataIdsAcrossGroups(groups, ids, 100)
    expect(capped).toHaveLength(100)
    expect(linearMetadataGroupCoverage(groups, capped, 100).atLimit).toBe(true)
    expect(isLinearMetadataGroupSelectionPartial(groups, capped, 100)).toBe(true)
  })

  it('never starves a single-id row to widen a row that has many ids', () => {
    const groups = [
      { key: 'wide', ids: Array.from({ length: 10 }, (_unused, index) => `w-${index}`) },
      { key: 'x', ids: ['x-1'] },
      { key: 'y', ids: ['y-1'] },
      { key: 'z', ids: ['z-1'] }
    ]
    const ids = groups.flatMap((group) => group.ids)
    const capped = capLinearMetadataIdsAcrossGroups(groups, ids, 5)
    expect(capped).toHaveLength(5)
    expect(capped).toContain('x-1')
    expect(capped).toContain('y-1')
    expect(capped).toContain('z-1')
  })

  // Why: the picker hands us click order, so the cap has to sort by metadata order instead.
  it('caps the same visible selection to the same ids whatever the click order', () => {
    const groups = [
      { key: 'alpha', ids: ['a-1', 'a-2', 'a-3'] },
      { key: 'beta', ids: ['b-1', 'b-2'] },
      { key: 'gamma', ids: ['c-1'] }
    ]
    const alphaFirst = ['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'c-1']
    const gammaFirst = ['c-1', 'b-1', 'b-2', 'a-1', 'a-2', 'a-3']
    expect(capLinearMetadataIdsAcrossGroups(groups, gammaFirst, 4)).toEqual(
      capLinearMetadataIdsAcrossGroups(groups, alphaFirst, 4)
    )
  })
})
