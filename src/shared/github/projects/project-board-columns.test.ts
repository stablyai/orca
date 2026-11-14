import { describe, expect, it } from 'vitest'
import { buildBoardColumns, resolveBoardColumnField } from './project-board-columns'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow,
  GitHubProjectView
} from './project-types'

const STATUS_FIELD: GitHubProjectField = {
  kind: 'single-select',
  id: 'f_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GREEN' },
    { id: 'opt_prog', name: 'In Progress', color: 'YELLOW' },
    { id: 'opt_done', name: 'Done', color: 'PURPLE' }
  ]
}

function view(overrides: Partial<GitHubProjectView>): GitHubProjectView {
  return {
    id: 'PVTV_1',
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

function row(id: string, values: GitHubProjectFieldValue[]): GitHubProjectRow {
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const value of values) {
    fieldValuesByFieldId[value.fieldId] = value
  }
  return {
    id,
    itemType: 'ISSUE',
    content: {
      number: 1,
      title: id,
      body: null,
      url: `https://github.com/o/r/issues/1`,
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'o/r',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId,
    updatedAt: '2026-09-01T00:00:00Z',
    position: 0
  }
}

const statusValue = (optionId: string, name: string): GitHubProjectFieldValue => ({
  kind: 'single-select',
  fieldId: 'f_status',
  optionId,
  name,
  color: ''
})

describe('resolveBoardColumnField', () => {
  it('ignores a non-select vertical field instead of building clear-only columns', () => {
    const textField: GitHubProjectField = {
      kind: 'field',
      id: 'f_text',
      name: 'Notes',
      dataType: 'TEXT'
    }
    const v = view({ fields: [STATUS_FIELD], verticalGroupByFields: [textField] })
    expect(resolveBoardColumnField(v)).toBe(STATUS_FIELD)
  })
})

describe('buildBoardColumns', () => {
  it('routes no-value rows to the trailing column whose drop clears the field', () => {
    const columns = buildBoardColumns(STATUS_FIELD, [row('a', [])])
    const trailing = columns.at(-1)!
    expect(trailing.label).toBe('No Status')
    expect(trailing.rows.map((r) => r.id)).toEqual(['a'])
    expect(trailing.dropValue).toBeNull()
  })

  it('keeps rows pointing at a deleted option in their own non-droppable column', () => {
    const columns = buildBoardColumns(STATUS_FIELD, [
      row('a', [statusValue('opt_gone', 'Archived')])
    ])
    const ghost = columns.find((c) => c.label === 'Archived')!
    expect(ghost.rows.map((r) => r.id)).toEqual(['a'])
    expect(ghost.dropValue).toBeUndefined()
    // Ghost columns sit between the real options and the no-value column.
    expect(columns.at(-1)?.label).toBe('No Status')
  })

  it('buckets non-select fields read-only', () => {
    const assignees: GitHubProjectField = {
      kind: 'field',
      id: 'f_assignees',
      name: 'Assignees',
      dataType: 'ASSIGNEES'
    }
    const columns = buildBoardColumns(assignees, [
      row('a', [
        {
          kind: 'users',
          fieldId: 'f_assignees',
          users: [{ login: 'alice', name: null, avatarUrl: null }]
        }
      ]),
      row('b', [])
    ])
    expect(columns.map((c) => c.label)).toEqual(['alice', 'No Assignees'])
    expect(columns[0]?.dropValue).toBeUndefined()
    expect(columns.at(-1)?.dropValue).toBeUndefined()
    expect(columns.at(-1)?.rows.map((r) => r.id)).toEqual(['b'])
  })
})
