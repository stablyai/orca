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
  values: GitHubProjectRow['fieldValuesByFieldId']
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
      parentIssue: null,
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
