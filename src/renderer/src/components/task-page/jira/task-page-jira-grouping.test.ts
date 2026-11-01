import { defaultJiraListColumnIds, visibleJiraListColumns } from '../../jira-list-columns'
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'

import { TaskPageJiraIssueList } from './task-page-jira-issue-list'

import type { JiraIssue } from '../../../../../shared/jira/jira-types'

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

describe('Jira issue status grouping', () => {
  it('collapses and expands a status group through its accessible trigger', async () => {
    const user = userEvent.setup()
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(TaskPageJiraIssueList, {
          columns: visibleJiraListColumns(defaultJiraListColumnIds()),
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
