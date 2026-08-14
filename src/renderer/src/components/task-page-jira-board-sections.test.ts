import { describe, expect, it } from 'vitest'
import { buildJiraBoardSections } from './task-page-jira-board-sections'
import type { JiraIssue, JiraStatus } from '../../../shared/types'

function status(id: string, name: string): JiraStatus {
  return { id, name, categoryKey: 'indeterminate', categoryName: 'In Progress' }
}

function issue(key: string, statusValue: JiraStatus): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'p1', key: 'STA', name: 'Stably' },
    issueType: { id: 't1', name: 'Task' },
    status: statusValue,
    labels: [],
    updatedAt: '2026-08-09T12:00:00.000Z',
    createdAt: '2026-08-09T12:00:00.000Z'
  }
}

const todo = status('1', 'To Do')
const inProgress = status('2', 'In Progress')
const done = status('3', 'Done')

describe('buildJiraBoardSections', () => {
  it('renders every board column, including empty ones, in board order', () => {
    const sections = buildJiraBoardSections([issue('STA-1', todo)], {
      statusIdsByColumn: [['1'], ['2'], ['3']],
      columns: [
        { name: 'To Do', statusIds: ['1'] },
        { name: 'Doing', statusIds: ['2'] },
        { name: 'Done', statusIds: ['3'] }
      ]
    })
    expect(sections.map((section) => section.label)).toEqual(['To Do', 'Doing', 'Done'])
    expect(sections.map((section) => section.issues.length)).toEqual([1, 0, 0])
    expect(sections[2].statusIds).toEqual(['3'])
  })

  it('appends lanes for statuses outside the board config', () => {
    const blocked = status('9', 'Blocked')
    const sections = buildJiraBoardSections([issue('STA-1', todo), issue('STA-2', blocked)], {
      statusIdsByColumn: [['1']],
      columns: [{ name: 'To Do', statusIds: ['1'] }]
    })
    expect(sections.map((section) => section.label)).toEqual(['To Do', 'Blocked'])
    expect(sections[1].issues.map((entry) => entry.key)).toEqual(['STA-2'])
  })

  it('groups a multi-status column into a single lane', () => {
    const sections = buildJiraBoardSections([issue('STA-1', todo), issue('STA-2', inProgress)], {
      statusIdsByColumn: [['1', '2']],
      columns: [{ name: 'Open work', statusIds: ['1', '2'] }]
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].issues.map((entry) => entry.key)).toEqual(['STA-1', 'STA-2'])
  })

  it('falls back to issue-derived sections without column metadata', () => {
    const sections = buildJiraBoardSections([issue('STA-1', done), issue('STA-2', todo)], {
      statusIdsByColumn: [['1'], ['3']]
    })
    expect(sections.map((section) => section.label)).toEqual(['To Do', 'Done'])
    expect(sections[1].statusIds).toEqual(['3'])
  })

  it('reverses lanes for descending status direction', () => {
    const sections = buildJiraBoardSections(
      [issue('STA-1', todo)],
      {
        statusIdsByColumn: [['1'], ['3']],
        columns: [
          { name: 'To Do', statusIds: ['1'] },
          { name: 'Done', statusIds: ['3'] }
        ]
      },
      'desc'
    )
    expect(sections.map((section) => section.label)).toEqual(['Done', 'To Do'])
  })
})
