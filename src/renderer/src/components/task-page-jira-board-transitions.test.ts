import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraStatus, JiraTransition } from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  jiraListTransitions: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListTransitions: mocks.jiraListTransitions
}))

const { findJiraBoardSectionTransition, loadTaskPageJiraIssueTransitions } =
  await import('./task-page-jira-board-transitions')

function status(id: string, name: string): JiraStatus {
  return { id, name, categoryKey: 'indeterminate', categoryName: 'In Progress' }
}

function transition(id: string, to: JiraStatus): JiraTransition {
  return { id, name: `To ${to.name}`, to }
}

function issue(key: string, statusValue: JiraStatus, siteId?: string): JiraIssue {
  return {
    id: key,
    key,
    siteId,
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'p1', key: 'STA', name: 'Stably' },
    issueType: { id: 't1', name: 'Task' },
    status: statusValue,
    labels: [],
    updatedAt: '2026-08-07T12:00:00.000Z',
    createdAt: '2026-08-07T12:00:00.000Z'
  }
}

describe('findJiraBoardSectionTransition', () => {
  const inProgress = status('2', 'In Progress')
  const done = status('3', 'Done')

  it('matches by the status id of issues already in the section', () => {
    const renamed = transition('t-done', { ...done, name: 'Completed' })
    const found = findJiraBoardSectionTransition([transition('t-ip', inProgress), renamed], {
      label: 'Done',
      issues: [issue('STA-1', done)]
    })
    expect(found).toBe(renamed)
  })

  it('falls back to matching the section label by status name', () => {
    const toDone = transition('t-done', done)
    const found = findJiraBoardSectionTransition([toDone], { label: 'Done', issues: [] })
    expect(found).toBe(toDone)
  })

  it('matches an empty column through its board-config status ids', () => {
    const renamed = transition('t-done', { ...done, name: 'Completed' })
    const found = findJiraBoardSectionTransition([renamed], {
      label: 'Done column',
      statusIds: ['3'],
      issues: []
    })
    expect(found).toBe(renamed)
  })

  it('returns null when no transition reaches the section', () => {
    expect(
      findJiraBoardSectionTransition([transition('t-ip', inProgress)], {
        label: 'Done',
        issues: [issue('STA-1', done)]
      })
    ).toBeNull()
  })
})

describe('loadTaskPageJiraIssueTransitions', () => {
  beforeEach(() => {
    mocks.jiraListTransitions.mockReset()
  })

  it('caches per issue status and refetches after the status changes', async () => {
    const inProgress = status('2', 'In Progress')
    const done = status('3', 'Done')
    mocks.jiraListTransitions.mockResolvedValue([transition('t-done', done)])
    const settings = {} as never

    await loadTaskPageJiraIssueTransitions(settings, 'scope', issue('STA-9', inProgress, 'site-a'))
    await loadTaskPageJiraIssueTransitions(settings, 'scope', issue('STA-9', inProgress, 'site-a'))
    expect(mocks.jiraListTransitions).toHaveBeenCalledTimes(1)

    await loadTaskPageJiraIssueTransitions(settings, 'scope', issue('STA-9', done, 'site-a'))
    expect(mocks.jiraListTransitions).toHaveBeenCalledTimes(2)
  })

  it('resolves an empty list when the transitions request fails', async () => {
    mocks.jiraListTransitions.mockRejectedValue(new Error('offline'))
    const result = await loadTaskPageJiraIssueTransitions(
      {} as never,
      'scope',
      issue('STA-500', status('2', 'In Progress'))
    )
    expect(result).toEqual([])
  })
})
