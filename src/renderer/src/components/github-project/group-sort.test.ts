import { describe, expect, it } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectSort,
  GitHubProjectTable,
  GitHubProjectView
} from '../../../../shared/github/project-types'
import { sortRows, groupRows } from '../../../../shared/github/project-group-sort'

const singleSelectField: GitHubProjectField = {
  kind: 'single-select',
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_a', name: 'Todo', color: 'GRAY' },
    { id: 'opt_b', name: 'In Progress', color: 'YELLOW' }
  ]
}

const assigneesField: GitHubProjectField = {
  kind: 'field',
  id: 'F_assignees',
  name: 'Assignees',
  dataType: 'ASSIGNEES'
}

const numberField: GitHubProjectField = {
  kind: 'field',
  id: 'F_points',
  name: 'Story Points',
  dataType: 'NUMBER'
}

function makeRow(
  id: string,
  position: number,
  values: GitHubProjectRow['fieldValuesByFieldId'],
  parentIssue: GitHubProjectRow['content']['parentIssue'] = null
): GitHubProjectRow {
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: 1,
      title: id,
      body: null,
      url: null,
      state: 'open',
      stateReason: null,
      isDraft: null,
      repository: 'acme/repo',
      assignees: [],
      labels: [],
      parentIssue,
      issueType: null
    },
    fieldValuesByFieldId: values,
    updatedAt: '2026-01-01T00:00:00Z',
    position
  }
}

function makeView(field: GitHubProjectField, sort?: GitHubProjectSort): GitHubProjectView {
  return {
    id: 'V_1',
    number: 1,
    name: 'Default',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [field],
    groupByFields: [],
    sortByFields: sort ? [sort] : []
  }
}

function makeTable(view: GitHubProjectView, rows: GitHubProjectRow[]): GitHubProjectTable {
  return {
    project: {
      id: 'P',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title: 'P',
      url: ''
    },
    selectedView: view,
    rows,
    totalCount: rows.length,
    parentFieldDropped: false
  }
}

describe('sortRows', () => {
  it('does not produce NaN when both rows reference unknown single-select options', () => {
    // Avoid Infinity - Infinity producing NaN and bypassing the position tie-break for orphaned options.
    const view = makeView(singleSelectField, {
      direction: 'ASC',
      field: singleSelectField
    })
    const rows = [
      makeRow('rB', 5, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'orphan_2',
          name: 'Gone',
          color: 'GRAY'
        }
      }),
      makeRow('rA', 1, {
        F_status: {
          kind: 'single-select',
          fieldId: 'F_status',
          optionId: 'orphan_1',
          name: 'Gone',
          color: 'GRAY'
        }
      })
    ]
    const sorted = sortRows(makeTable(view, rows), rows)
    expect(sorted.map((r) => r.id)).toEqual(['rA', 'rB'])
  })

  it('sorts an empty user list last in both directions, like a missing value', () => {
    const rows = [
      makeRow('empty-list', 0, {
        F_assignees: { kind: 'users', fieldId: 'F_assignees', users: [] }
      }),
      makeRow('alice', 1, {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'alice', name: null, avatarUrl: null }]
        }
      }),
      makeRow('no-value', 2, {})
    ]

    for (const direction of ['ASC', 'DESC'] as const) {
      const view = makeView(assigneesField, { direction, field: assigneesField })
      const sorted = sortRows(makeTable(view, rows), rows)
      expect(sorted.map((r) => r.id)).toEqual(['alice', 'empty-list', 'no-value'])
    }
  })
})

describe('groupRows', () => {
  it('groups a present-but-empty user list with the missing-value rows', () => {
    const view = { ...makeView(assigneesField), groupByFields: [assigneesField] }
    const rows = [
      makeRow('empty-list', 0, {
        F_assignees: { kind: 'users', fieldId: 'F_assignees', users: [] }
      }),
      makeRow('alice', 1, {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'alice', name: null, avatarUrl: null }]
        }
      }),
      makeRow('no-value', 2, {})
    ]

    const groups = groupRows(makeTable(view, rows), rows)

    expect(groups.map((group) => [group.label, group.rows.map((r) => r.id)])).toEqual([
      ['alice', ['alice']],
      ['No Assignees', ['empty-list', 'no-value']]
    ])
  })

  it('orders number-field groups by value, not by the rendered label', () => {
    const view = { ...makeView(numberField), groupByFields: [numberField] }
    const rows = [8, 10, -2, 2, -10, 1].map((points, index) =>
      makeRow(`p${index}`, index, {
        F_points: { kind: 'number', fieldId: 'F_points', number: points }
      })
    )

    const groups = groupRows(makeTable(view, rows), rows)

    expect(groups.map((group) => group.label)).toEqual(['-10', '-2', '1', '2', '8', '10'])
  })

  it('groups by Parent issue from row content, since GitHub returns no field value for it', () => {
    const parentField: GitHubProjectField = {
      kind: 'field',
      id: 'F_parent',
      name: 'Parent issue',
      dataType: 'PARENT_ISSUE'
    }
    const view = { ...makeView(parentField), groupByFields: [parentField] }
    const parent = (repo: string, number: number) => ({
      number,
      title: `Parent ${number}`,
      url: `https://github.com/${repo}/issues/${number}`
    })
    const rows = [
      makeRow('a1', 0, {}, parent('acme/repo', 101)),
      makeRow('b', 1, {}, parent('acme/repo', 9)),
      makeRow('orphan', 2, {}),
      makeRow('a2', 3, {}, parent('acme/repo', 101)),
      makeRow('other-repo', 4, {}, parent('acme/other', 101))
    ]

    const groups = groupRows(makeTable(view, rows), rows)

    expect(groups.map((group) => [group.label, group.rows.map((r) => r.id)])).toEqual([
      ['#9', ['b']],
      ['#101', ['a1', 'a2']],
      ['#101', ['other-repo']],
      ['No Parent issue', ['orphan']]
    ])
  })
})

it('uses the first iteration ordering and metadata when legacy field IDs repeat', () => {
  const field: GitHubProjectField = {
    kind: 'iteration',
    id: 'iteration',
    name: 'Iteration',
    dataType: 'ITERATION',
    iterations: [
      { id: 'a', title: 'First', startDate: '2026-01-01', duration: 7, completed: true },
      { id: 'b', title: 'Second', startDate: '2026-02-01', duration: 14, completed: false },
      { id: 'a', title: 'Duplicate', startDate: '2026-03-01', duration: 21, completed: false }
    ]
  }
  const rows = ['b', 'a'].map((id, index) =>
    makeRow(id, index, {
      iteration: {
        kind: 'iteration',
        fieldId: 'iteration',
        iterationId: id,
        title: id,
        startDate: '2026-01-01',
        duration: 7
      }
    })
  )
  const table = makeTable(
    { ...makeView(field, { field, direction: 'ASC' }), groupByFields: [field] },
    rows
  )
  expect(sortRows(table, rows).map((row) => row.id)).toEqual(['a', 'b'])
  expect(groupRows(table, rows)[0].iteration).toEqual({
    startDate: '2026-01-01',
    duration: 7,
    completed: true
  })
})

it('sorts content-backed parents with absent values last and secondary sorts before positions', () => {
  const field: GitHubProjectField = {
    kind: 'field',
    id: 'parent',
    name: 'Parent issue',
    dataType: 'PARENT_ISSUE'
  }
  const parent = (repo: string, number: number) => ({
    number,
    title: 'Parent',
    url: `https://github.com/${repo}/issues/${number}`
  })
  const rows = [
    makeRow('high', 0, {}, parent('acme/repo', 101)),
    makeRow('low', 1, {}, parent('acme/repo', 9)),
    makeRow('absent', 2, { parent: { kind: 'number', fieldId: 'parent', number: 1 } }),
    makeRow(
      'same',
      3,
      { F_points: { kind: 'number', fieldId: 'F_points', number: 1 } },
      parent('acme/other', 101)
    )
  ]
  rows[0].fieldValuesByFieldId.F_points = { kind: 'number', fieldId: 'F_points', number: 9 }
  for (const [direction, expected] of [
    ['ASC', ['low', 'same', 'high', 'absent']],
    ['DESC', ['same', 'high', 'low', 'absent']]
  ] as const) {
    const view = {
      ...makeView(field),
      sortByFields: [
        { field, direction },
        { field: numberField, direction: 'ASC' as const }
      ]
    }
    expect(sortRows(makeTable(view, rows), rows).map((row) => row.id)).toEqual(expected)
  }
})

it('groups repositories from content and orders synthetic progress groups numerically', () => {
  const field: GitHubProjectField = {
    kind: 'field',
    id: 'repo',
    name: 'Repository',
    dataType: 'REPOSITORY'
  }
  const rows = [makeRow('z', 0, {}), makeRow('a', 1, {}), makeRow('empty', 2, {})]
  rows[0].content.repository = 'acme/z'
  rows[1].content.repository = 'acme/a'
  rows[2].content.repository = null
  const table = makeTable(
    { ...makeView(field, { field, direction: 'DESC' }), groupByFields: [field] },
    rows
  )
  expect(
    groupRows(table, rows).map((group) => [group.label, group.rows.map((row) => row.id)])
  ).toEqual([
    ['acme/a', ['a']],
    ['acme/z', ['z']],
    ['No Repository', ['empty']]
  ])
  expect(sortRows(table, rows).map((row) => row.id)).toEqual(['z', 'a', 'empty'])
  const progress: GitHubProjectField = {
    kind: 'field',
    id: 'progress',
    name: 'Sub-issues progress',
    dataType: 'SUB_ISSUES_PROGRESS'
  }
  const progressRows = [90, 100, 20, 0].map((percent, index) => {
    const row = makeRow(`p${percent}`, index, {})
    row.content.subIssuesProgress = {
      completed: percent / 10,
      total: percent === 0 ? 0 : 10,
      percentCompleted: percent
    }
    return row
  })
  const progressTable = makeTable(
    { ...makeView(progress, { field: progress, direction: 'DESC' }), groupByFields: [progress] },
    progressRows
  )
  expect(groupRows(progressTable, progressRows).map((group) => group.label)).toEqual([
    '2/10 (20%)',
    '9/10 (90%)',
    '10/10 (100%)',
    'No Sub-issues progress'
  ])
  expect(sortRows(progressTable, progressRows).map((row) => row.id)).toEqual([
    'p100',
    'p90',
    'p20',
    'p0'
  ])
})
