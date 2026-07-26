// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import { sortJiraIssues } from './jira-issue-sorter'
import { groupJiraIssuesByStatus, TaskPageJiraIssueList } from './task-page-jira-issue-list'
import {
  getSingleJiraProjectScope,
  loadTaskPageJiraProjectStatusOrder
} from './task-page-jira-status-order'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/types'

const { jiraGetProjectStatusOrderMock } = vi.hoisted(() => ({
  jiraGetProjectStatusOrderMock: vi.fn()
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetProjectStatusOrder: (...args: unknown[]) => jiraGetProjectStatusOrderMock(...args)
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  jiraGetProjectStatusOrderMock.mockReset()
})

function jiraIssue(
  key: string,
  title: string,
  statusId: string,
  statusName: string,
  options: { priority?: string; projectKey?: string; siteId?: string } = {}
): JiraIssue {
  const siteId = options.siteId ?? 'site-1'
  const projectKey = options.projectKey ?? 'ALP'
  return {
    id: `${siteId}:${key}`,
    key,
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    siteId,
    siteName: 'Example Jira',
    project: { id: projectKey, key: projectKey, name: projectKey, siteId },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: statusId, name: statusName, categoryKey: 'new', categoryName: statusName },
    priority: options.priority ? { id: options.priority, name: options.priority } : undefined,
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function statusOrder(statusIdsByColumn: string[][]): JiraProjectStatusOrder {
  return { statusIdsByColumn }
}

describe('Jira issue status grouping', () => {
  it('groups issues through the production implementation and preserves row order', () => {
    const first = jiraIssue('ALP-1', 'First', '1', 'To Do')
    const second = jiraIssue('ALP-2', 'Second', '2', 'In Progress')
    const third = jiraIssue('ALP-3', 'Third', '1', 'To Do')

    const sections = groupJiraIssuesByStatus([first, second, third], null)

    expect(sections.map((section) => section.label)).toEqual(['In Progress', 'To Do'])
    expect(sections[1]?.issues).toEqual([first, third])
  })

  it('uses Jira column order while sorting statuses in the same column alphabetically', () => {
    const sections = groupJiraIssuesByStatus(
      [
        jiraIssue('ALP-1', 'Done issue', '3', 'Done'),
        jiraIssue('ALP-2', 'To do issue', '1', 'To Do'),
        jiraIssue('ALP-3', 'Progress issue', '2', 'In Progress')
      ],
      statusOrder([['1', '2'], ['3']])
    )

    expect(sections.map((section) => section.label)).toEqual(['In Progress', 'To Do', 'Done'])
  })

  it('reverses Jira column order for descending status sort', () => {
    const sections = groupJiraIssuesByStatus(
      [
        jiraIssue('ALP-1', 'Done issue', '3', 'Done'),
        jiraIssue('ALP-2', 'To do issue', '1', 'To Do'),
        jiraIssue('ALP-3', 'Progress issue', '2', 'In Progress')
      ],
      statusOrder([['1', '2'], ['3']]),
      'desc'
    )

    expect(sections.map((section) => section.label)).toEqual(['Done', 'To Do', 'In Progress'])
  })

  it('preserves priority sorting inside the production status groups', () => {
    const sortedIssues = sortJiraIssues(
      [
        jiraIssue('ALP-1', 'High issue', '1', 'To Do', { priority: 'High' }),
        jiraIssue('ALP-2', 'Low issue', '1', 'To Do', { priority: 'Low' })
      ],
      'priority',
      'asc'
    )

    const sections = groupJiraIssuesByStatus(sortedIssues, statusOrder([['1']]))

    expect(sections[0]?.issues.map((issue) => issue.key)).toEqual(['ALP-2', 'ALP-1'])
  })

  it('places statuses missing from board configuration last in alphabetical order', () => {
    const sections = groupJiraIssuesByStatus(
      [
        jiraIssue('ALP-1', 'Done issue', '3', 'Done'),
        jiraIssue('ALP-2', 'To do issue', '1', 'To Do'),
        jiraIssue('ALP-3', 'Progress issue', '2', 'In Progress')
      ],
      statusOrder([['2']])
    )

    expect(sections.map((section) => section.label)).toEqual(['In Progress', 'Done', 'To Do'])
  })

  it('only selects a board-order scope for one Jira site and project', () => {
    const singleScope = getSingleJiraProjectScope([
      jiraIssue('ALP-1', 'First', '1', 'To Do'),
      jiraIssue('ALP-2', 'Second', '2', 'In Progress')
    ])
    const multipleSites = getSingleJiraProjectScope([
      jiraIssue('ALP-1', 'First', '1', 'To Do', { siteId: 'site-1' }),
      jiraIssue('ALP-2', 'Second', '2', 'In Progress', { siteId: 'site-2' })
    ])
    const multipleProjects = getSingleJiraProjectScope([
      jiraIssue('ALP-1', 'First', '1', 'To Do', { projectKey: 'ALP' }),
      jiraIssue('BRV-1', 'Second', '2', 'In Progress', { projectKey: 'BRV' })
    ])
    const missingSite = jiraIssue('ALP-3', 'Third', '3', 'Done')
    delete missingSite.siteId
    delete missingSite.project.siteId

    expect(singleScope).toMatchObject({ projectKey: 'ALP', siteId: 'site-1' })
    expect(multipleSites).toBeNull()
    expect(multipleProjects).toBeNull()
    expect(getSingleJiraProjectScope([missingSite])).toBeNull()
  })

  it('uses alphabetical fallback when status-order metadata is unavailable', async () => {
    const error = new Error('Unknown RPC method')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    jiraGetProjectStatusOrderMock.mockRejectedValueOnce(error)
    const scope = getSingleJiraProjectScope([jiraIssue('ALP-1', 'First', '1', 'To Do')])
    if (!scope) {
      throw new Error('Expected one Jira project scope')
    }

    await expect(loadTaskPageJiraProjectStatusOrder(null, 'runtime:old', scope)).resolves.toEqual({
      statusIdsByColumn: []
    })
    expect(warn).toHaveBeenCalledWith('[jira] Failed to load project status order:', error)
  })

  it('collapses and expands a status group through its accessible trigger', async () => {
    const user = userEvent.setup()
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(TaskPageJiraIssueList, {
          formatUpdatedAt: () => 'today',
          getStatusTone: () => 'border-border',
          issues: [
            jiraIssue('ALP-1', 'First issue', '1', 'To Do'),
            jiraIssue('ALP-2', 'Second issue', '1', 'To Do')
          ],
          onOpenIssue: vi.fn(),
          onStartWorkspace: vi.fn(),
          selectedIssue: null,
          showSiteContext: false,
          statusOrder: null
        })
      )
    )

    const trigger = screen.getByRole('button', { name: 'To Do 2' })
    expect(trigger).toHaveAttribute('data-variant', 'ghost')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('First issue')).toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('First issue')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByText('First issue')).toBeInTheDocument()
  })
})
