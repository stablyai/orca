import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraPriority } from '../../../shared/types'

describe('TaskPage Jira sorting functionality', () => {
  function jiraIssue(
    key: string,
    title: string,
    statusName: string,
    priorityName?: string,
    priorityId?: string,
    assigneeDisplayName?: string,
    updatedAt = '2026-01-01T00:00:00.000Z',
    siteId = 'site-1'
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
      status: { id: '1', name: statusName, categoryKey: 'new', categoryName: statusName },
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
    return { id, name, description: '', iconUrl: '' }
  }

  describe('getJiraPriorityWeight', () => {
    it('returns default weight for missing priority', () => {
      const jiraPriorities: JiraPriority[] = []
      const getPriorityWeight = (priorityName?: string, priorityId?: string): number => {
        if (!priorityName) {
          return 99
        }
        if (jiraPriorities.length > 0) {
          const idx = jiraPriorities.findIndex(
            (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
          )
          if (idx !== -1) {
            return idx
          }
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        if (priorityId) {
          const parsed = Number.parseInt(priorityId, 10)
          if (!Number.isNaN(parsed)) {
            return parsed
          }
        }
        return 3
      }

      expect(getPriorityWeight(undefined, undefined)).toBe(99)
    })

    it('uses priority index from Jira priorities list when available', () => {
      const jiraPriorities: JiraPriority[] = [
        jiraPriority('1', 'Highest'),
        jiraPriority('2', 'High'),
        jiraPriority('3', 'Medium'),
        jiraPriority('4', 'Low')
      ]
      const getPriorityWeight = (priorityName?: string, priorityId?: string): number => {
        if (!priorityName) {
          return 99
        }
        if (jiraPriorities.length > 0) {
          const idx = jiraPriorities.findIndex(
            (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
          )
          if (idx !== -1) {
            return idx
          }
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        if (priorityId) {
          const parsed = Number.parseInt(priorityId, 10)
          if (!Number.isNaN(parsed)) {
            return parsed
          }
        }
        return 3
      }

      expect(getPriorityWeight('High', '2')).toBe(1)
      expect(getPriorityWeight('Medium', '3')).toBe(2)
    })

    it('falls back to priority name mapping when not in priorities list', () => {
      const jiraPriorities: JiraPriority[] = []
      const getPriorityWeight = (priorityName?: string, priorityId?: string): number => {
        if (!priorityName) {
          return 99
        }
        if (jiraPriorities.length > 0) {
          const idx = jiraPriorities.findIndex(
            (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
          )
          if (idx !== -1) {
            return idx
          }
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        if (priorityId) {
          const parsed = Number.parseInt(priorityId, 10)
          if (!Number.isNaN(parsed)) {
            return parsed
          }
        }
        return 3
      }

      expect(getPriorityWeight('Blocker', '1')).toBe(1)
      expect(getPriorityWeight('High', '2')).toBe(2)
      expect(getPriorityWeight('Medium', '3')).toBe(3)
      expect(getPriorityWeight('Low', '4')).toBe(4)
      expect(getPriorityWeight('Lowest', '5')).toBe(5)
    })

    it('parses priority ID as number when name mapping fails', () => {
      const jiraPriorities: JiraPriority[] = []
      const getPriorityWeight = (priorityName?: string, priorityId?: string): number => {
        if (!priorityName) {
          return 99
        }
        if (jiraPriorities.length > 0) {
          const idx = jiraPriorities.findIndex(
            (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
          )
          if (idx !== -1) {
            return idx
          }
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        if (priorityId) {
          const parsed = Number.parseInt(priorityId, 10)
          if (!Number.isNaN(parsed)) {
            return parsed
          }
        }
        return 3
      }

      expect(getPriorityWeight('Custom Priority', '10')).toBe(10)
      expect(getPriorityWeight('Another', '5')).toBe(5)
    })

    it('returns default weight for unknown priority', () => {
      const jiraPriorities: JiraPriority[] = []
      const getPriorityWeight = (priorityName?: string, priorityId?: string): number => {
        if (!priorityName) {
          return 99
        }
        if (jiraPriorities.length > 0) {
          const idx = jiraPriorities.findIndex(
            (p) => p.id === priorityId || p.name.toLowerCase() === priorityName.toLowerCase()
          )
          if (idx !== -1) {
            return idx
          }
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        if (priorityId) {
          const parsed = Number.parseInt(priorityId, 10)
          if (!Number.isNaN(parsed)) {
            return parsed
          }
        }
        return 3
      }

      expect(getPriorityWeight('Unknown Priority', 'invalid')).toBe(3)
    })
  })

  describe('issue sorting', () => {
    it('sorts by key in ascending order', () => {
      const issues = [
        jiraIssue('ALP-10', 'Issue 10', 'To Do'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do'),
        jiraIssue('ALP-1', 'Issue 1', 'To Do')
      ]

      const sorted = [...issues].sort((a, b) =>
        a.key.localeCompare(b.key, undefined, { numeric: true })
      )

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

      const sorted = [...issues]
        .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
        .toReversed()

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

      const sorted = [...issues].sort((a, b) => a.title.localeCompare(b.title))

      expect(sorted[0].title).toBe('Apple Issue')
      expect(sorted[1].title).toBe('Banana Issue')
      expect(sorted[2].title).toBe('Zebra Issue')
    })

    it('sorts by priority weight (highest priority first)', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do', 'Low', '4'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do', 'High', '2'),
        jiraIssue('ALP-3', 'Issue 3', 'To Do', 'Medium', '3')
      ]

      const getPriorityWeight = (priorityName?: string): number => {
        if (!priorityName) {
          return 99
        }
        const nameKey = priorityName.toLowerCase()
        const JIRA_PRIORITY_ORDER: Record<string, number> = {
          blocker: 1,
          highest: 1,
          critical: 1,
          high: 2,
          major: 2,
          medium: 3,
          normal: 3,
          low: 4,
          minor: 4,
          lowest: 5,
          trivial: 5
        }
        if (nameKey in JIRA_PRIORITY_ORDER) {
          return JIRA_PRIORITY_ORDER[nameKey]
        }
        return 3
      }

      const sorted = [...issues].sort((a, b) => {
        const weightA = getPriorityWeight(a.priority?.name)
        const weightB = getPriorityWeight(b.priority?.name)
        return weightA - weightB
      })

      expect(sorted[0].priority?.name).toBe('High')
      expect(sorted[1].priority?.name).toBe('Medium')
      expect(sorted[2].priority?.name).toBe('Low')
    })

    it('sorts by assignee alphabetically', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do', undefined, undefined, 'Zoe'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do', undefined, undefined, 'Alice'),
        jiraIssue('ALP-3', 'Issue 3', 'To Do', undefined, undefined, 'Bob')
      ]

      const sorted = [...issues].sort((a, b) => {
        const userA = a.assignee?.displayName ?? ''
        const userB = b.assignee?.displayName ?? ''
        return userA.localeCompare(userB)
      })

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

      const sorted = [...issues].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )

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

      const sorted = [...issues].sort((a, b) => {
        const userA = a.assignee?.displayName ?? ''
        const userB = b.assignee?.displayName ?? ''
        return userA.localeCompare(userB)
      })

      expect(sorted[0].assignee?.displayName).toBeUndefined()
      expect(sorted[1].assignee?.displayName).toBe('Alice')
      expect(sorted[2].assignee?.displayName).toBe('Bob')
    })
  })

  describe('issue sections with sorting', () => {
    it('groups issues by status after sorting', () => {
      const issues = [
        jiraIssue('ALP-3', 'Issue 3', 'Done', 'High'),
        jiraIssue('ALP-1', 'Issue 1', 'To Do', 'Low'),
        jiraIssue('ALP-2', 'Issue 2', 'In Progress', 'Medium')
      ]

      const sorted = [...issues].sort((a, b) => {
        const getPriorityWeight = (priorityName?: string): number => {
          if (!priorityName) {
            return 99
          }
          const nameKey = priorityName.toLowerCase()
          const JIRA_PRIORITY_ORDER: Record<string, number> = {
            blocker: 1,
            highest: 1,
            critical: 1,
            high: 2,
            major: 2,
            medium: 3,
            normal: 3,
            low: 4,
            minor: 4,
            lowest: 5,
            trivial: 5
          }
          if (nameKey in JIRA_PRIORITY_ORDER) {
            return JIRA_PRIORITY_ORDER[nameKey]
          }
          return 3
        }
        const weightA = getPriorityWeight(a.priority?.name)
        const weightB = getPriorityWeight(b.priority?.name)
        return weightB - weightA
      })

      const sectionsMap = new Map<string, JiraIssue[]>()
      for (const issue of sorted) {
        const statusName = issue.status.name
        if (!sectionsMap.has(statusName)) {
          sectionsMap.set(statusName, [])
        }
        sectionsMap.get(statusName)!.push(issue)
      }

      const sections: { key: string; label: string; issues: JiraIssue[] }[] = []
      sectionsMap.forEach((issues, statusName) => {
        sections.push({
          key: statusName,
          label: statusName,
          issues
        })
      })

      sections.sort((a, b) => a.label.localeCompare(b.label))

      expect(sections[0].label).toBe('Done')
      expect(sections[0].issues[0].key).toBe('ALP-3')
      expect(sections[1].label).toBe('In Progress')
      expect(sections[1].issues[0].key).toBe('ALP-2')
      expect(sections[2].label).toBe('To Do')
      expect(sections[2].issues[0].key).toBe('ALP-1')
    })

    it('reverses section order when sorting by status descending', () => {
      const sections = [
        { key: 'Done', label: 'Done', issues: [] },
        { key: 'In Progress', label: 'In Progress', issues: [] },
        { key: 'To Do', label: 'To Do', issues: [] }
      ]

      sections.sort((a, b) => a.label.localeCompare(b.label))
      const reversed = sections.toReversed()

      expect(reversed[0].label).toBe('To Do')
      expect(reversed[1].label).toBe('In Progress')
      expect(reversed[2].label).toBe('Done')
    })
  })
})
