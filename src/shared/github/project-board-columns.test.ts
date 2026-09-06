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

const SPRINT_FIELD: GitHubProjectField = {
  kind: 'iteration',
  id: 'f_sprint',
  name: 'Sprint',
  dataType: 'ITERATION',
  iterations: [
    { id: 'it_1', title: 'Sprint 1', startDate: '2026-08-24', duration: 14, completed: true },
    { id: 'it_2', title: 'Sprint 2', startDate: '2026-09-07', duration: 14, completed: false }
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
  it('prefers the view-configured vertical group field', () => {
    const v = view({ fields: [STATUS_FIELD], verticalGroupByFields: [SPRINT_FIELD] })
    expect(resolveBoardColumnField(v)).toBe(SPRINT_FIELD)
  })

  it('falls back to the Status field, then any single-select', () => {
    const priority: GitHubProjectField = { ...STATUS_FIELD, id: 'f_prio', name: 'Priority' }
    expect(resolveBoardColumnField(view({ fields: [priority, STATUS_FIELD] }))).toBe(STATUS_FIELD)
    expect(resolveBoardColumnField(view({ fields: [priority] }))).toBe(priority)
  })

  it('returns null when nothing can shape columns', () => {
    expect(
      resolveBoardColumnField(
        view({ fields: [{ kind: 'field', id: 'f_t', name: 'Title', dataType: 'TITLE' }] })
      )
    ).toBeNull()
  })
})

describe('buildBoardColumns', () => {
  it('emits every option as a column in option order, empty ones included', () => {
    const columns = buildBoardColumns(STATUS_FIELD, [
      row('a', [statusValue('opt_done', 'Done')]),
      row('b', [statusValue('opt_todo', 'Todo')])
    ])
    expect(columns.map((c) => c.label)).toEqual(['Todo', 'In Progress', 'Done', 'No Status'])
    expect(columns.map((c) => c.rows.length)).toEqual([1, 0, 1, 0])
    expect(columns[0]?.dropValue).toEqual({ kind: 'single-select', optionId: 'opt_todo' })
    expect(columns[0]?.color).toBe('GREEN')
  })

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

  it('builds iteration columns with iteration drops', () => {
    const columns = buildBoardColumns(SPRINT_FIELD, [
      row('a', [
        {
          kind: 'iteration',
          fieldId: 'f_sprint',
          iterationId: 'it_2',
          title: 'Sprint 2',
          startDate: '2026-09-07',
          duration: 14
        }
      ])
    ])
    expect(columns.map((c) => c.label)).toEqual(['Sprint 1', 'Sprint 2', 'No Sprint'])
    expect(columns[1]?.dropValue).toEqual({ kind: 'iteration', iterationId: 'it_2' })
    expect(columns[1]?.rows.map((r) => r.id)).toEqual(['a'])
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
    expect(columns.at(-1)?.rows.map((r) => r.id)).toEqual(['b'])
  })
})
