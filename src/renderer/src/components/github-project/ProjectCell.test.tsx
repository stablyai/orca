// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow
} from '../../../../shared/github/project-types'
import ProjectCell from './ProjectCell'

function row(
  fieldValue?: GitHubProjectFieldValue,
  subIssuesProgress?: GitHubProjectRow['content']['subIssuesProgress']
): GitHubProjectRow {
  return {
    id: 'item-1',
    itemType: 'ISSUE',
    content: {
      number: 42,
      title: 'Parent issue',
      body: null,
      url: 'https://github.com/o/r/issues/42',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'o/r',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null,
      subIssuesProgress
    },
    fieldValuesByFieldId: fieldValue ? { [fieldValue.fieldId]: fieldValue } : {},
    updatedAt: '2026-10-07T00:00:00Z',
    position: 0
  }
}

function field(dataType: 'LINKED_PULL_REQUESTS' | 'SUB_ISSUES_PROGRESS'): GitHubProjectField {
  return { kind: 'field', id: 'field-1', name: dataType, dataType }
}

afterEach(cleanup)

describe('ProjectCell extended values', () => {
  it('shows linked PRs and how many were omitted from the first page', () => {
    const value: GitHubProjectFieldValue = {
      kind: 'pull-requests',
      fieldId: 'field-1',
      pullRequests: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }],
      truncated: true,
      totalCount: 3
    }
    render(
      <ProjectCell
        row={row(value)}
        field={field('LINKED_PULL_REQUESTS')}
        editable={false}
        sourceSettings={null}
      />
    )
    expect(screen.getByText('#12 +2').textContent).toBe('#12 +2')
  })

  it('shows the Issue sub-issues summary in its project column', () => {
    render(
      <ProjectCell
        row={row(undefined, { completed: 1, total: 2, percentCompleted: 50 })}
        field={field('SUB_ISSUES_PROGRESS')}
        editable={false}
        sourceSettings={null}
      />
    )
    expect(screen.getByText('1/2 (50%)').textContent).toBe('1/2 (50%)')
  })
})
