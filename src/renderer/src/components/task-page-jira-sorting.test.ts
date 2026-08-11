import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraPriority } from '../../../shared/types'
import { getJiraPriorityWeight, sortJiraIssues } from './jira-issue-sorter'

describe('TaskPage Jira sorting functionality', () => {
  function jiraIssue(
    key: string,
    title: string,
    statusName: string,
    priorityName?: string,
    priorityId?: string,
    assigneeDisplayName?: string,
    updatedAt = '2026-01-01T00:00:00.000Z',
    siteId = 'site-1',
    categoryKey = 'new'
  ): JiraIssue {
    return {
      id: `${siteId}:${key}`,
      key,
      title,
      url: `https://example.atlassian.net/browse/${key}`,
      siteId,
      siteName: 'Example Jira',
      project: { id: '10000', key: 'ALP', name: 'Alpha', siteId },
      issueType: { id: '10001', name: 'Bug' },
      status: { id: '1', name: statusName, categoryKey, categoryName: statusName },
      priority: priorityName ? { id: priorityId ?? '1', name: priorityName } : undefined,
      assignee: assigneeDisplayName
        ? { accountId: 'user-1', displayName: assigneeDisplayName }
        : undefined,
      labels: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt
    }
  }

  function jiraPriority(id: string, name: string): JiraPriority {
    return { id, name }
  }

  describe('getJiraPriorityWeight', () => {
    it('returns default weight for missing priority', () => {
      expect(getJiraPriorityWeight(undefined, undefined, [])).toBe(0)
    })

    it('uses priority index from Jira priorities list when available', () => {
      const jiraPriorities: JiraPriority[] = [
        jiraPriority('1', 'Highest'),
        jiraPriority('2', 'High'),
        jiraPriority('3', 'Medium'),
        jiraPriority('4', 'Low')
      ]

      expect(getJiraPriorityWeight('High', '2', jiraPriorities)).toBeCloseTo(66.33, 2)
      expect(getJiraPriorityWeight('Medium', '3', jiraPriorities)).toBeCloseTo(33.67, 2)
    })

    it('keeps missing priority below the lowest configured priority', () => {
      const jiraPriorities = [jiraPriority('1', 'High'), jiraPriority('2', 'Low')]

      expect(getJiraPriorityWeight(undefined, undefined, jiraPriorities)).toBe(0)
      expect(getJiraPriorityWeight('Low', '2', jiraPriorities)).toBe(1)
    })

    it('falls back to priority name mapping when not in priorities list', () => {
      expect(getJiraPriorityWeight('Blocker', '1', [])).toBe(99)
      expect(getJiraPriorityWeight('High', '2', [])).toBe(75)
      expect(getJiraPriorityWeight('Medium', '3', [])).toBe(50)
      expect(getJiraPriorityWeight('Low', '4', [])).toBe(25)
      expect(getJiraPriorityWeight('Lowest', '5', [])).toBe(1)
    })

    it('does not treat opaque custom priority IDs as ordering ranks', () => {
      expect(getJiraPriorityWeight('Custom Priority', '10', [])).toBe(50)
      expect(getJiraPriorityWeight('Another', '5', [])).toBe(50)
      expect(getJiraPriorityWeight('Unknown Priority', 'invalid', [])).toBe(50)
    })
  })

  describe('issue sorting', () => {
    it('sorts by key in ascending order', () => {
      const issues = [
        jiraIssue('ALP-10', 'Issue 10', 'To Do'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do'),
        jiraIssue('ALP-1', 'Issue 1', 'To Do')
      ]

      const sorted = sortJiraIssues(issues, 'key', 'asc')

      expect(sorted[0].key).toBe('ALP-1')
      expect(sorted[1].key).toBe('ALP-2')
      expect(sorted[2].key).toBe('ALP-10')
    })

    it('sorts by key in descending order', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do'),
        jiraIssue('ALP-10', 'Issue 10', 'To Do')
      ]

      const sorted = sortJiraIssues(issues, 'key', 'desc')

      expect(sorted[0].key).toBe('ALP-10')
      expect(sorted[1].key).toBe('ALP-2')
      expect(sorted[2].key).toBe('ALP-1')
    })

    it('sorts by title alphabetically', () => {
      const issues = [
        jiraIssue('ALP-1', 'Zebra Issue', 'To Do'),
        jiraIssue('ALP-2', 'Apple Issue', 'To Do'),
        jiraIssue('ALP-3', 'Banana Issue', 'To Do')
      ]

      const sorted = sortJiraIssues(issues, 'title', 'asc')

      expect(sorted[0].title).toBe('Apple Issue')
      expect(sorted[1].title).toBe('Banana Issue')
      expect(sorted[2].title).toBe('Zebra Issue')
    })

    it('sorts by priority weight (lowest priority first)', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do', 'Low', '4'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do', 'High', '2'),
        jiraIssue('ALP-3', 'Issue 3', 'To Do', 'Medium', '3')
      ]

      const sorted = sortJiraIssues(issues, 'priority', 'asc')

      expect(sorted[0].priority?.name).toBe('Low')
      expect(sorted[1].priority?.name).toBe('Medium')
      expect(sorted[2].priority?.name).toBe('High')
    })

    it('uses each Jira site priority order when sorting an all-sites list', () => {
      const issues = [
        jiraIssue(
          'BRV-1',
          'Site B low by name',
          'To Do',
          'Low',
          '2',
          undefined,
          undefined,
          'site-b'
        ),
        jiraIssue(
          'BRV-2',
          'Site B high by name',
          'To Do',
          'High',
          '1',
          undefined,
          undefined,
          'site-b'
        )
      ]
      const prioritiesBySite = new Map<string, JiraPriority[]>([
        ['site-a', [jiraPriority('1', 'High'), jiraPriority('2', 'Low')]],
        ['site-b', [jiraPriority('2', 'Low'), jiraPriority('1', 'High')]]
      ])

      const sorted = sortJiraIssues(issues, 'priority', 'asc', prioritiesBySite)

      expect(sorted.map((issue) => issue.key)).toEqual(['BRV-2', 'BRV-1'])
    })

    it('normalizes priority ranks across sites with different tier counts', () => {
      const issues = [
        jiraIssue(
          'ALP-1',
          'Site A highest',
          'To Do',
          'Highest',
          '1',
          undefined,
          undefined,
          'site-a'
        ),
        jiraIssue('BRV-1', 'Site B medium', 'To Do', 'Medium', '3', undefined, undefined, 'site-b')
      ]
      const prioritiesBySite = new Map<string, JiraPriority[]>([
        ['site-a', [jiraPriority('1', 'Highest'), jiraPriority('2', 'Lowest')]],
        [
          'site-b',
          [
            jiraPriority('1', 'Highest'),
            jiraPriority('2', 'High'),
            jiraPriority('3', 'Medium'),
            jiraPriority('4', 'Low'),
            jiraPriority('5', 'Lowest')
          ]
        ]
      ])

      const sorted = sortJiraIssues(issues, 'priority', 'asc', prioritiesBySite)

      expect(sorted.map((issue) => issue.key)).toEqual(['BRV-1', 'ALP-1'])
    })

    it('sorts by assignee alphabetically', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do', undefined, undefined, 'Zoe'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do', undefined, undefined, 'Alice'),
        jiraIssue('ALP-3', 'Issue 3', 'To Do', undefined, undefined, 'Bob')
      ]

      const sorted = sortJiraIssues(issues, 'assignee', 'asc')

      expect(sorted[0].assignee?.displayName).toBe('Alice')
      expect(sorted[1].assignee?.displayName).toBe('Bob')
      expect(sorted[2].assignee?.displayName).toBe('Zoe')
    })

    it('sorts by updated date (newest first)', () => {
      const issues = [
        jiraIssue(
          'ALP-1',
          'Issue 1',
          'To Do',
          undefined,
          undefined,
          undefined,
          '2026-01-01T00:00:00.000Z'
        ),
        jiraIssue(
          'ALP-2',
          'Issue 2',
          'To Do',
          undefined,
          undefined,
          undefined,
          '2026-01-03T00:00:00.000Z'
        ),
        jiraIssue(
          'ALP-3',
          'Issue 3',
          'To Do',
          undefined,
          undefined,
          undefined,
          '2026-01-02T00:00:00.000Z'
        )
      ]

      const sorted = sortJiraIssues(issues, 'updated', 'desc')

      expect(sorted[0].key).toBe('ALP-2')
      expect(sorted[1].key).toBe('ALP-3')
      expect(sorted[2].key).toBe('ALP-1')
    })

    it('handles unassigned assignees in sorting', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do', undefined, undefined, 'Alice'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do', undefined, undefined, undefined),
        jiraIssue('ALP-3', 'Issue 3', 'To Do', undefined, undefined, 'Bob')
      ]

      const sorted = sortJiraIssues(issues, 'assignee', 'asc')

      expect(sorted[0].assignee?.displayName).toBeUndefined()
      expect(sorted[1].assignee?.displayName).toBe('Alice')
      expect(sorted[2].assignee?.displayName).toBe('Bob')
    })
  })
})
