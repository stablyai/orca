// @vitest-environment happy-dom
//
// Why: Phase 1b — ProjectCell needs dedicated dispatch branches for
// SUB_ISSUES_PROGRESS (Issue.subIssuesSummary) and TRACKS / TRACKED_BY
// (Issue.trackedIssues / Issue.trackedInIssues), plus the existing
// PARENT_ISSUE branch becomes a clickable link. The tests below drive
// each branch and the parent-link improvement.
//
// Mock surface: ProjectCell uses window.api.shell.openUrl to open issue
// URLs in the user's browser (same helper ProjectViewWrapper.tsx:519
// uses). Mocked via vi.stubGlobal in beforeEach.
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubProjectField,
  GitHubProjectParentIssue,
  GitHubProjectRow
} from '../../../../shared/github-project-types'
import ProjectCell from './ProjectCell'

// Minimal content builder for tests — only the fields the cell reads.
function makeContent(
  overrides: Partial<GitHubProjectRow['content']> = {}
): GitHubProjectRow['content'] {
  return {
    number: 1,
    title: 't',
    body: null,
    url: null,
    state: null,
    stateReason: null,
    isDraft: null,
    repository: null,
    assignees: [],
    labels: [],
    parentIssue: null,
    issueType: null,
    subIssuesSummary: null,
    trackedIssues: [],
    trackedInIssues: [],
    ...overrides
  }
}

function makeRow(overrides: Partial<GitHubProjectRow> = {}): GitHubProjectRow {
  return {
    id: 'item-1',
    itemType: 'ISSUE',
    content: makeContent(),
    fieldValuesByFieldId: {},
    updatedAt: '',
    position: 0,
    ...overrides
  } as GitHubProjectRow
}

function makeField(
  id: string,
  dataType: GitHubProjectField extends { dataType: infer T } ? T : never,
  name = dataType
): GitHubProjectField {
  return {
    kind: 'field',
    id,
    name,
    dataType
  } as GitHubProjectField
}

beforeEach(() => {
  vi.stubGlobal('api', {
    shell: {
      openUrl: vi.fn().mockResolvedValue(undefined)
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProjectCell — Sub-issue progress (Issue.subIssuesSummary)', () => {
  it('renders "3/7" for subIssuesSummary { total: 7, completed: 3, percentCompleted: 43 }', () => {
    const field = makeField('F', 'SUB_ISSUES_PROGRESS')
    const row = makeRow({
      content: makeContent({
        subIssuesSummary: { total: 7, completed: 3, percentCompleted: 43 }
      })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    expect(screen.getByText('3/7')).toBeInTheDocument()
  })

  it('renders an em dash for total: 0 (and never "0/0")', () => {
    const field = makeField('F', 'SUB_ISSUES_PROGRESS')
    const row = makeRow({
      content: makeContent({
        subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }
      })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0/0')).not.toBeInTheDocument()
  })
})

describe('ProjectCell — Tracks (Issue.trackedIssues)', () => {
  function makeParentIssue(n: number): GitHubProjectParentIssue {
    return {
      number: n,
      title: `tracked ${n}`,
      url: `https://github.com/acme/repo/issues/${n}`
    }
  }

  it('renders the first 3 issues as links and a "+2" tail when there are 5', () => {
    const field = makeField('F', 'TRACKS')
    const tracked = [
      makeParentIssue(1),
      makeParentIssue(2),
      makeParentIssue(3),
      makeParentIssue(4),
      makeParentIssue(5)
    ]
    const row = makeRow({
      content: makeContent({ trackedIssues: tracked })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    // First three rendered as links
    expect(screen.getByRole('link', { name: '#1' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#2' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '#3' })).toBeInTheDocument()
    // 4 and 5 not rendered (collapsed into the tail)
    expect(screen.queryByRole('link', { name: '#4' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '#5' })).not.toBeInTheDocument()
    // Tail
    expect(screen.getByText('+2')).toBeInTheDocument()
  })
})

describe('ProjectCell — Tracked by (Issue.trackedInIssues)', () => {
  it('renders trackedInIssues with a "←" prefix', () => {
    const field = makeField('F', 'TRACKED_BY')
    const row = makeRow({
      content: makeContent({
        trackedInIssues: [
          { number: 9, title: 'epic', url: 'https://github.com/acme/repo/issues/9' }
        ]
      })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    expect(screen.getByRole('link', { name: '#9' })).toBeInTheDocument()
    expect(screen.getByText('←')).toBeInTheDocument()
  })
})

describe('ProjectCell — Parent issue link', () => {
  it('renders a clickable <a> with the parent URL and the issue number visible', () => {
    const field = makeField('F', 'PARENT_ISSUE')
    const row = makeRow({
      content: makeContent({
        parentIssue: {
          number: 42,
          title: 'epic: ship phase 1',
          url: 'https://github.com/acme/repo/issues/42'
        }
      })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    const link = screen.getByRole('link', { name: '#42' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/issues/42')
    expect(link).toHaveAttribute('title', 'epic: ship phase 1')
  })

  it('falls back to a plain #number when the parent URL is empty (no <a>)', () => {
    const field = makeField('F', 'PARENT_ISSUE')
    const row = makeRow({
      content: makeContent({
        parentIssue: { number: 42, title: 'epic', url: '' }
      })
    })
    render(<ProjectCell row={row} field={field} editable={false} sourceSettings={null} />)
    expect(screen.queryByRole('link', { name: '#42' })).not.toBeInTheDocument()
    // The number is still visible in the cell, just not as a link.
    expect(screen.getByText('#42')).toBeInTheDocument()
  })
})
