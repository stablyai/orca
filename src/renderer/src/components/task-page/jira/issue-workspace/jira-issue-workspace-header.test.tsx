// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'

afterEach(cleanup)

const issue = {
  id: '1',
  key: 'APP-1',
  siteName: 'Signed In User',
  title: 'Fix login',
  url: 'https://jira.example.com/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  updatedBy: { accountId: 'person-b', displayName: 'Person B' }
} as JiraIssue

function renderHeader(displayed: JiraIssue) {
  render(
    <TooltipProvider>
      <JiraIssueWorkspaceHeader
        displayed={displayed}
        issueLoading={false}
        onUse={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('Jira issue header editor', () => {
  it('shows the changelog editor instead of the signed-in account name', () => {
    renderHeader(issue)
    expect(screen.getByText('Person B')).toBeTruthy()
    expect(screen.queryByText('Signed In User')).toBeNull()
    expect(screen.getByText('APP')).toBeTruthy()
  })

  it('omits a name when the last editor is unknown', () => {
    const { updatedBy: _updatedBy, ...withoutEditor } = issue
    renderHeader(withoutEditor)
    expect(screen.queryByText('Signed In User')).toBeNull()
    expect(screen.queryByText('Person B')).toBeNull()
  })
})
