// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearGroupBy } from '../../../shared/linear/issue-view-resume-state'
import type { LinearIssueListRow } from './task-page-linear-issue-model'
import type { TaskPageLinearListProjectionPreludeModel } from './use-task-page-linear-list-projection'
import { useTaskPageLinearListPresentation } from './use-task-page-linear-list-presentation'

function issue(identifier: string, status: string, teamId = 'team-1'): LinearIssue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    url: 'https://linear.app/issue',
    priority: 0,
    updatedAt: '2026-01-02T00:00:00.000Z',
    state: { name: status, type: 'unstarted', color: '#000' },
    team: { id: teamId, name: teamId, key: 'COR' },
    labels: [],
    labelIds: []
  }
}

const TODO_ONE = issue('COR-1', 'Todo')
const TODO_TWO = issue('COR-2', 'Todo')
const DONE_ONE = issue('COR-3', 'Done')
const ALL_ISSUES = [TODO_ONE, TODO_TWO, DONE_ONE]

type LinearView = { kind: 'list' } | { kind: 'project'; id: string } | { kind: 'view'; id: string }

const MY_ISSUES: LinearView = { kind: 'list' }

function viewFields(view: LinearView) {
  if (view.kind === 'project') {
    return {
      linearMode: 'projects',
      linearProjectTab: 'issues',
      selectedLinearProject: { id: view.id },
      selectedLinearCustomView: null
    }
  }
  if (view.kind === 'view') {
    return {
      linearMode: 'views',
      linearProjectTab: 'overview',
      selectedLinearProject: null,
      selectedLinearCustomView: { id: view.id, model: 'issue' }
    }
  }
  return {
    linearMode: 'issues',
    linearProjectTab: 'overview',
    selectedLinearProject: null,
    selectedLinearCustomView: null
  }
}

function preludeModel(
  linearGroupBy: LinearGroupBy,
  pagedLinearIssues: LinearIssue[],
  view: LinearView
): TaskPageLinearListProjectionPreludeModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prelude model is a wide derived type, but the presentation hook reads only the fields listed here.
  return {
    linearDisplayProperties: new Set<string>(),
    linearGroupBy,
    linearOrderBy: 'identifier',
    linearTeamOptions: [],
    linearTeamPropertyTouched: false,
    linearTeamSelection: new Set<string>(),
    pagedLinearIssues,
    ...viewFields(view)
  } as unknown as TaskPageLinearListProjectionPreludeModel
}

function sectionKeys(rows: LinearIssueListRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'section' ? [row.key] : []))
}

function collapsedKeys(rows: LinearIssueListRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'section' && row.collapsed ? [row.key] : []))
}

function issueIdentifiers(rows: LinearIssueListRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'issue' ? [row.issue.identifier] : []))
}

function renderGroupedList(
  linearGroupBy: LinearGroupBy = 'status',
  issues: LinearIssue[] = [TODO_ONE, TODO_TWO, DONE_ONE],
  view: LinearView = MY_ISSUES
) {
  return renderHook(
    ({
      groupBy,
      pagedIssues,
      activeView
    }: {
      groupBy: LinearGroupBy
      pagedIssues: LinearIssue[]
      activeView: LinearView
    }) => useTaskPageLinearListPresentation(preludeModel(groupBy, pagedIssues, activeView)),
    { initialProps: { groupBy: linearGroupBy, pagedIssues: issues, activeView: view } }
  )
}

describe('useTaskPageLinearListPresentation collapse', () => {
  it('hides a collapsed section and marks its header row', () => {
    const view = renderGroupedList()

    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual([
      'COR-1',
      'COR-2',
      'COR-3'
    ])
    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual([])

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual(['status:Todo'])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual(['COR-3'])
  })

  it('keeps the header row and its count while the section is collapsed', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })

    const header = view.result.current.linearIssueListRows.find(
      (row) => row.type === 'section' && row.key === 'status:Todo'
    )
    expect(header).toEqual({
      type: 'section',
      key: 'status:Todo',
      label: 'Todo',
      count: 2,
      collapsed: true
    })
  })

  it('restores the rows when the same section is toggled again', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual([])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual([
      'COR-1',
      'COR-2',
      'COR-3'
    ])
  })

  it('leaves other sections untouched when one collapses', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Done')
    })

    expect(sectionKeys(view.result.current.linearIssueListRows)).toEqual([
      'status:Todo',
      'status:Done'
    ])
    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual(['status:Done'])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual(['COR-1', 'COR-2'])
  })

  it('clears collapsed sections when the grouping changes', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    view.rerender({ groupBy: 'team', pagedIssues: ALL_ISSUES, activeView: MY_ISSUES })
    view.rerender({ groupBy: 'status', pagedIssues: ALL_ISSUES, activeView: MY_ISSUES })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual([])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual([
      'COR-1',
      'COR-2',
      'COR-3'
    ])
  })

  it('keeps a section collapsed when a new page of issues arrives', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    view.rerender({
      groupBy: 'status',
      pagedIssues: [TODO_ONE, TODO_TWO, issue('COR-4', 'Todo'), DONE_ONE],
      activeView: MY_ISSUES
    })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual(['status:Todo'])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual(['COR-3'])
  })

  it('clears collapsed sections when the active Linear view changes', () => {
    const view = renderGroupedList()

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    // Same grouping, so the section keys are identical — only the view differs.
    view.rerender({
      groupBy: 'status',
      pagedIssues: ALL_ISSUES,
      activeView: { kind: 'project', id: 'project-1' }
    })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual([])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual([
      'COR-1',
      'COR-2',
      'COR-3'
    ])
  })

  it('never paints a stale collapse on the first render of a new view', () => {
    const rendered: LinearIssueListRow[][] = []
    const initialProps: { activeView: LinearView } = { activeView: MY_ISSUES }
    const view = renderHook(
      ({ activeView }: { activeView: LinearView }) => {
        const model = useTaskPageLinearListPresentation(
          preludeModel('status', ALL_ISSUES, activeView)
        )
        rendered.push(model.linearIssueListRows)
        return model
      },
      { initialProps }
    )

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    const beforeSwitch = rendered.length
    view.rerender({ activeView: { kind: 'project', id: 'project-1' } })

    // A reset that only runs in an effect leaves the first render of the new
    // view holding the old set, so the section flashes collapsed before it opens.
    for (const rows of rendered.slice(beforeSwitch)) {
      expect(issueIdentifiers(rows)).toEqual(['COR-1', 'COR-2', 'COR-3'])
    }
  })

  it('does not carry a collapse between two projects', () => {
    const view = renderGroupedList('status', ALL_ISSUES, { kind: 'project', id: 'project-1' })

    act(() => {
      view.result.current.toggleLinearSection('status:Todo')
    })
    view.rerender({
      groupBy: 'status',
      pagedIssues: ALL_ISSUES,
      activeView: { kind: 'project', id: 'project-2' }
    })

    expect(collapsedKeys(view.result.current.linearIssueListRows)).toEqual([])
  })

  it('renders no section rows and ignores a toggle when grouping is none', () => {
    const view = renderGroupedList('none')

    expect(sectionKeys(view.result.current.linearIssueListRows)).toEqual([])

    act(() => {
      view.result.current.toggleLinearSection('all')
    })

    expect(sectionKeys(view.result.current.linearIssueListRows)).toEqual([])
    expect(issueIdentifiers(view.result.current.linearIssueListRows)).toEqual([
      'COR-1',
      'COR-2',
      'COR-3'
    ])
  })
})
