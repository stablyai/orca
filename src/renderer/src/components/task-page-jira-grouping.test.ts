import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/types'

describe('TaskPage Jira grouping functionality', () => {
  function jiraIssue(key: string, title: string, statusName: string, siteId = 'site-1'): JiraIssue {
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
      labels: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  describe('jira issue sections grouping', () => {
    it('groups issues by status name', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'To Do'),
        jiraIssue('ALP-2', 'Issue 2', 'In Progress'),
        jiraIssue('ALP-3', 'Issue 3', 'To Do'),
        jiraIssue('ALP-4', 'Issue 4', 'Done')
      ]

      const sectionsMap = new Map<string, JiraIssue[]>()
      for (const issue of issues) {
        const statusName = issue.status.name
        if (!sectionsMap.has(statusName)) {
          sectionsMap.set(statusName, [])
        }
        sectionsMap.get(statusName)!.push(issue)
      }

      expect(sectionsMap.size).toBe(3)
      expect(sectionsMap.get('To Do')?.length).toBe(2)
      expect(sectionsMap.get('In Progress')?.length).toBe(1)
      expect(sectionsMap.get('Done')?.length).toBe(1)
    })

    it('sorts sections by agile board column configuration when available', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'Done'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do'),
        jiraIssue('ALP-3', 'Issue 3', 'In Progress')
      ]

      const jiraProjectStatuses: Record<string, string[]> = {
        ALP: ['In Progress', 'To Do', 'Done']
      }

      const sectionsMap = new Map<string, JiraIssue[]>()
      for (const issue of issues) {
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

      const getStatusIndex = (statusName: string): number => {
        for (const projectKey of Object.keys(jiraProjectStatuses)) {
          const list = jiraProjectStatuses[projectKey]
          if (list) {
            const idx = list.indexOf(statusName)
            if (idx !== -1) {
              return idx
            }
          }
        }
        return 99999
      }

      sections.sort((a, b) => {
        const idxA = getStatusIndex(a.label)
        const idxB = getStatusIndex(b.label)
        if (idxA !== idxB) {
          return idxA - idxB
        }
        return a.label.localeCompare(b.label)
      })

      expect(sections.at(0)?.label).toBe('In Progress')
      expect(sections.at(1)?.label).toBe('To Do')
      expect(sections.at(2)?.label).toBe('Done')
    })

    it('falls back to alphabetical sorting when no board configuration exists', () => {
      const issues = [
        jiraIssue('ALP-1', 'Issue 1', 'Done'),
        jiraIssue('ALP-2', 'Issue 2', 'To Do'),
        jiraIssue('ALP-3', 'Issue 3', 'In Progress')
      ]

      const jiraProjectStatuses: Record<string, string[]> = {}

      const sectionsMap = new Map<string, JiraIssue[]>()
      for (const issue of issues) {
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

      const getStatusIndex = (statusName: string): number => {
        for (const projectKey of Object.keys(jiraProjectStatuses)) {
          const list = jiraProjectStatuses[projectKey]
          if (list) {
            const idx = list.indexOf(statusName)
            if (idx !== -1) {
              return idx
            }
          }
        }
        return 99999
      }

      sections.sort((a, b) => {
        const idxA = getStatusIndex(a.label)
        const idxB = getStatusIndex(b.label)
        if (idxA !== idxB) {
          return idxA - idxB
        }
        return a.label.localeCompare(b.label)
      })

      expect(sections.at(0)?.label).toBe('Done')
      expect(sections.at(1)?.label).toBe('In Progress')
      expect(sections.at(2)?.label).toBe('To Do')
    })
  })

  describe('collapsed groups state management', () => {
    it('toggles group collapse state correctly', () => {
      let collapsedGroups = new Set<string>(['To Do'])

      const toggleGroup = (groupKey: string, current: Set<string>) => {
        const next = new Set(current)
        if (next.has(groupKey)) {
          next.delete(groupKey)
        } else {
          next.add(groupKey)
        }
        return next
      }

      collapsedGroups = toggleGroup('To Do', collapsedGroups)
      expect(collapsedGroups.has('To Do')).toBe(false)

      collapsedGroups = toggleGroup('In Progress', collapsedGroups)
      expect(collapsedGroups.has('In Progress')).toBe(true)
      expect(collapsedGroups.has('To Do')).toBe(false)

      collapsedGroups = toggleGroup('To Do', collapsedGroups)
      expect(collapsedGroups.has('To Do')).toBe(true)
      expect(collapsedGroups.has('In Progress')).toBe(true)
    })

    it('filters issues based on collapsed state', () => {
      const collapsedGroups = new Set<string>(['To Do'])

      const sections = [
        { key: 'To Do', label: 'To Do', issues: [jiraIssue('ALP-1', 'Issue 1', 'To Do')] },
        {
          key: 'In Progress',
          label: 'In Progress',
          issues: [jiraIssue('ALP-2', 'Issue 2', 'In Progress')]
        }
      ]

      const visibleIssues = sections
        .filter((section) => !collapsedGroups.has(section.key))
        .flatMap((section) => section.issues)

      expect(visibleIssues.length).toBe(1)
      expect(visibleIssues.at(0)?.key).toBe('ALP-2')
    })
  })
})
