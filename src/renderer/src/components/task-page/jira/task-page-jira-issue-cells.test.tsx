// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import { JiraIssueCell } from './task-page-jira-issue-cells'

afterEach(cleanup)

const LONG_TYPE_NAME = 'Custom issue type with a name long enough to truncate'

function jiraIssueType(name: string, iconUrl?: string): JiraIssue {
  return {
    id: 'type-cell-fixture',
    key: 'DEMO-1',
    title: 'Issue type cell fixture',
    url: 'https://example.atlassian.net/browse/DEMO-1',
    project: { id: 'demo', key: 'DEMO', name: 'Demo' },
    issueType: { id: 'custom', name, iconUrl },
    status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function renderTypeCell(issue: JiraIssue) {
  return render(
    <JiraIssueCell
      column="type"
      issue={issue}
      formatUpdatedAt={() => 'today'}
      getStatusTone={() => ''}
    />
  )
}

describe('Jira issue type cell', () => {
  it.each([
    ['Bug', undefined],
    ['Custom Request', 'https://example.atlassian.net/type-icon.png'],
    ['Issue', undefined],
    [LONG_TYPE_NAME, undefined]
  ])('renders the type name as truncated text: %s', (name, iconUrl) => {
    const { container } = renderTypeCell(jiraIssueType(name, iconUrl))
    const typeName = screen.getByText(name, { exact: true })

    expect(typeName).toHaveAttribute('title', name)
    expect(typeName).toHaveClass('truncate')
    expect(container.querySelector('img')).toBeNull()
  })

  it('treats markup-like provider names as escaped text', () => {
    const markupLikeName = '<img src=x onerror=alert(1)>'
    const { container } = renderTypeCell(jiraIssueType(markupLikeName))

    expect(screen.getByText(markupLikeName, { exact: true })).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
