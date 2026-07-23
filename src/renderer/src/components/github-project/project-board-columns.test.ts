import { describe, expect, it } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectView
} from '../../../../shared/github-project-types'
import {
  buildBoardColumns,
  resolveBoardGroupField
} from '../../../../shared/github-project-board-columns'

const statusField = {
  kind: 'single-select',
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
    { id: 'opt_doing', name: 'Doing', color: 'YELLOW' },
    { id: 'opt_done', name: 'Done', color: 'GREEN' }
  ]
} satisfies GitHubProjectField

const priorityField = {
  kind: 'single-select',
  id: 'F_priority',
  name: 'Priority',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'opt_p1', name: 'P1', color: 'RED' }]
} satisfies GitHubProjectField

const textField: GitHubProjectField = {
  kind: 'field',
  id: 'F_notes',
  name: 'Notes',
  dataType: 'TEXT'
}

const assigneesField: GitHubProjectField = {
  kind: 'field',
  id: 'F_assignees',
  name: 'Assignees',
  dataType: 'ASSIGNEES'
}

const iterationField = {
  kind: 'iteration',
  id: 'F_sprint',
  name: 'Sprint',
  dataType: 'ITERATION',
  iterations: [
    {
      id: 'it_1',
      title: 'Sprint 1',
      startDate: '2026-01-01',
      duration: 14,
      completed: true
    },
    {
      id: 'it_2',
      title: 'Sprint 2',
      startDate: '2026-01-15',
      duration: 14,
      completed: false
    }
  ]
} satisfies GitHubProjectField

function makeView(overrides: Partial<GitHubProjectView>): GitHubProjectView {
  return {
    id: 'V_1',
    number: 1,
    name: 'Board',
    layout: 'BOARD_LAYOUT',
    filter: '',
    fields: [],
    groupByFields: [],
    sortByFields: [],
    ...overrides
  }
}

function makeRow(id: string, values: GitHubProjectRow['fieldValuesByFieldId']): GitHubProjectRow {
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
    position: 0
  }
}

function statusValue(
  optionId: string,
  name: string
): GitHubProjectRow['fieldValuesByFieldId'][string] {
  return {
    kind: 'single-select',
    fieldId: 'F_status',
    optionId,
    name,
    color: 'GRAY'
  }
}

describe('resolveBoardGroupField', () => {
  it('uses verticalGroupByFields over the view fields', () => {
    const view = makeView({
      fields: [statusField, priorityField],
      verticalGroupByFields: [priorityField]
    })
    expect(resolveBoardGroupField(view)?.id).toBe('F_priority')
  })

  it('honors non-single-select grouping instead of falling back to Status', () => {
    const view = makeView({
      fields: [statusField, assigneesField],
      verticalGroupByFields: [assigneesField]
    })
    expect(resolveBoardGroupField(view)?.id).toBe('F_assignees')
  })

  it('falls back to Status, then any single-select, for views cached before verticalGroupByFields', () => {
    expect(resolveBoardGroupField(makeView({ fields: [priorityField, statusField] }))?.id).toBe(
      'F_status'
    )
    expect(resolveBoardGroupField(makeView({ fields: [priorityField] }))?.id).toBe('F_priority')
  })

  it('returns null when the fallback finds no single-select field', () => {
    expect(resolveBoardGroupField(makeView({ fields: [textField] }))).toBeNull()
  })
})

describe('buildBoardColumns', () => {
  it('emits one column per option in option order, including empty ones', () => {
    const rows = [makeRow('r1', { F_status: statusValue('opt_done', 'Done') })]
    const columns = buildBoardColumns(statusField, rows)
    expect(columns.map((c) => c.label)).toEqual(['Todo', 'Doing', 'Done'])
    expect(columns.map((c) => c.rows.length)).toEqual([0, 0, 1])
  })

  it('buckets valueless rows into a trailing "No <field>" column only when present', () => {
    const withMissing = buildBoardColumns(statusField, [
      makeRow('r1', { F_status: statusValue('opt_todo', 'Todo') }),
      makeRow('r2', {})
    ])
    expect(withMissing.at(-1)?.label).toBe('No Status')
    expect(withMissing.at(-1)?.rows.map((r) => r.id)).toEqual(['r2'])

    const allValued = buildBoardColumns(statusField, [
      makeRow('r1', { F_status: statusValue('opt_todo', 'Todo') })
    ])
    expect(allValued.map((c) => c.label)).toEqual(['Todo', 'Doing', 'Done'])
  })

  it('keeps rows whose option was deleted in their own labeled column', () => {
    const columns = buildBoardColumns(statusField, [
      makeRow('r1', { F_status: statusValue('opt_ghost', 'Archived') })
    ])
    expect(columns.map((c) => c.label)).toEqual(['Todo', 'Doing', 'Done', 'Archived'])
    expect(columns.at(-1)?.rows.map((r) => r.id)).toEqual(['r1'])
  })

  it('preserves input row order within a column', () => {
    const columns = buildBoardColumns(statusField, [
      makeRow('r2', { F_status: statusValue('opt_todo', 'Todo') }),
      makeRow('r1', { F_status: statusValue('opt_todo', 'Todo') })
    ])
    expect(columns[0].rows.map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('groups by a users field without inventing single-select columns', () => {
    const columns = buildBoardColumns(assigneesField, [
      makeRow('r1', {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'zoe', name: null, avatarUrl: null }]
        }
      }),
      makeRow('r2', {
        F_assignees: {
          kind: 'users',
          fieldId: 'F_assignees',
          users: [{ login: 'amy', name: null, avatarUrl: null }]
        }
      }),
      makeRow('r3', {})
    ])
    // Non-single-select columns follow the table's group order: label-sorted,
    // no-value last, and no empty columns since there are no options.
    expect(columns.map((c) => c.label)).toEqual(['amy', 'zoe', 'No Assignees'])
    expect(columns.every((c) => c.color === '')).toBe(true)
  })

  it('orders iteration columns by the field iteration order, not alphabetically', () => {
    const columns = buildBoardColumns(iterationField, [
      makeRow('r1', {
        F_sprint: {
          kind: 'iteration',
          fieldId: 'F_sprint',
          iterationId: 'it_2',
          title: 'Sprint 2',
          startDate: '2026-01-15',
          duration: 14
        }
      }),
      makeRow('r2', {
        F_sprint: {
          kind: 'iteration',
          fieldId: 'F_sprint',
          iterationId: 'it_1',
          title: 'Sprint 1',
          startDate: '2026-01-01',
          duration: 14
        }
      })
    ])
    expect(columns.map((c) => c.label)).toEqual(['Sprint 1', 'Sprint 2'])
  })
})
