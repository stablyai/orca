// @vitest-environment happy-dom
//
// Why: Phase 2 — SubIssuesSection is the drawer surface for issue-level
// hierarchy: shows the parent link (if any), the direct sub-issues with a
// roll-up progress summary, and add/remove/reorder affordances. Mock
// surface: window.api.gh.{getIssueHierarchy,addSubIssue,removeSubIssue,
// reprioritizeSubIssue} and window.api.shell.openUrl, stubbed per-test via
// vi.stubGlobal (same pattern as ProjectCell.test.tsx).
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GetIssueHierarchyResult,
  GitHubIssueHierarchyNode
} from '../../../../shared/github-project-types'
import SubIssuesSection from './SubIssuesSection'

function makeChild(overrides: Partial<GitHubIssueHierarchyNode> = {}): GitHubIssueHierarchyNode {
  return {
    number: 38,
    title: 'Story A',
    url: 'https://github.com/acme/widgets/issues/38',
    state: 'OPEN',
    subIssuesSummary: null,
    subIssues: [],
    ...overrides
  }
}

type ApiMocks = {
  getIssueHierarchy: ReturnType<typeof vi.fn>
  addSubIssue: ReturnType<typeof vi.fn>
  removeSubIssue: ReturnType<typeof vi.fn>
  reprioritizeSubIssue: ReturnType<typeof vi.fn>
  openUrl: ReturnType<typeof vi.fn>
}

function stubApi(hierarchyResult: GetIssueHierarchyResult): ApiMocks {
  const mocks: ApiMocks = {
    getIssueHierarchy: vi.fn().mockResolvedValue(hierarchyResult),
    addSubIssue: vi.fn().mockResolvedValue({
      ok: true,
      subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }
    }),
    removeSubIssue: vi.fn().mockResolvedValue({
      ok: true,
      subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }
    }),
    reprioritizeSubIssue: vi.fn().mockResolvedValue({ ok: true }),
    openUrl: vi.fn().mockResolvedValue(undefined)
  }
  vi.stubGlobal('api', {
    gh: {
      getIssueHierarchy: mocks.getIssueHierarchy,
      addSubIssue: mocks.addSubIssue,
      removeSubIssue: mocks.removeSubIssue,
      reprioritizeSubIssue: mocks.reprioritizeSubIssue
    },
    shell: { openUrl: mocks.openUrl }
  })
  return mocks
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SubIssuesSection', () => {
  it('fetches hierarchy on mount with owner/repo/number', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    await waitFor(() => {
      expect(mocks.getIssueHierarchy).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'widgets',
        number: 37
      })
    })
  })

  it('renders a clickable parent link that opens the parent URL', async () => {
    const mocks = stubApi({
      ok: true,
      parent: { number: 12, title: 'Epic', url: 'https://github.com/acme/widgets/issues/12' },
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    const link = await screen.findByRole('link', { name: /#12/ })
    fireEvent.click(link)
    expect(mocks.openUrl).toHaveBeenCalledWith('https://github.com/acme/widgets/issues/12')
  })

  it('renders no parent row when parent is null', async () => {
    stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: [makeChild({ number: 38 })],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    // Why: wait for the loaded state first — the "Parent" text is also
    // absent during the loading state, so asserting its absence before the
    // async fetch resolves would pass trivially regardless of this branch.
    await screen.findByRole('link', { name: /#38/ })
    expect(screen.queryByText(/Parent/i)).not.toBeInTheDocument()
  })

  it('renders each direct sub-issue with number, title, and a roll-up progress summary', async () => {
    stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 2, completed: 1, percentCompleted: 50 },
      subIssues: [
        makeChild({ number: 38, title: 'Story A', state: 'CLOSED' }),
        makeChild({ number: 39, title: 'Story B', state: 'OPEN' })
      ],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    expect(await screen.findByRole('link', { name: /#38/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /#39/ })).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('renders nothing when there is no parent, no sub-issues, and not editable', async () => {
    stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    const { container } = render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    await waitFor(() => {
      expect(container.textContent).toBe('')
    })
  })

  it('shows an add-sub-issue affordance when editable, even with zero sub-issues', async () => {
    stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    expect(await screen.findByRole('button', { name: /add sub-issue/i })).toBeInTheDocument()
  })

  it('calls addSubIssue with the parsed issue number when the add form is submitted', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const input = await screen.findByPlaceholderText(/issue number/i)
    fireEvent.change(input, { target: { value: '44' } })
    fireEvent.click(screen.getByRole('button', { name: /add sub-issue/i }))
    await waitFor(() => {
      expect(mocks.addSubIssue).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'widgets',
        number: 37,
        subIssueNumber: 44
      })
    })
  })

  it('calls removeSubIssue when the remove button on a child row is clicked', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: [makeChild({ number: 38 })],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const removeButton = await screen.findByRole('button', { name: /remove #38/i })
    fireEvent.click(removeButton)
    await waitFor(() => {
      expect(mocks.removeSubIssue).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'widgets',
        number: 37,
        subIssueNumber: 38
      })
    })
  })

  it('calls reprioritizeSubIssue with the preceding sibling as afterNumber when moving a row down', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 2, completed: 0, percentCompleted: 0 },
      subIssues: [makeChild({ number: 38 }), makeChild({ number: 39 })],
      hasMoreChildren: false
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const moveDown = await screen.findByRole('button', { name: /move #38 down/i })
    fireEvent.click(moveDown)
    await waitFor(() => {
      expect(mocks.reprioritizeSubIssue).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'widgets',
        number: 37,
        subIssueNumber: 38,
        afterNumber: 39
      })
    })
  })

  it('renders the error message when getIssueHierarchy resolves ok:false', async () => {
    stubApi({
      ok: false,
      error: { type: 'not_found', message: 'Issue not found.' }
    })
    render(
      <SubIssuesSection
        owner="acme"
        repo="widgets"
        number={37}
        editable={false}
        sourceSettings={null}
      />
    )
    expect(await screen.findByText('Issue not found.')).toBeInTheDocument()
  })

  it('shows an error message when addSubIssue resolves ok:false, without clearing the input', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: null,
      subIssues: [],
      hasMoreChildren: false
    })
    mocks.addSubIssue.mockResolvedValueOnce({
      ok: false,
      error: { type: 'validation', message: 'Issue #44 is already a sub-issue.' }
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const input = await screen.findByPlaceholderText(/issue number/i)
    fireEvent.change(input, { target: { value: '44' } })
    fireEvent.click(screen.getByRole('button', { name: /add sub-issue/i }))
    expect(await screen.findByText('Issue #44 is already a sub-issue.')).toBeInTheDocument()
    expect(input).toHaveValue('44')
    // Why: proves the failure branch skipped load() rather than silently reloading.
    expect(mocks.getIssueHierarchy).toHaveBeenCalledTimes(1)
  })

  it('shows an error message when removeSubIssue resolves ok:false', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 1, completed: 0, percentCompleted: 0 },
      subIssues: [makeChild({ number: 38 })],
      hasMoreChildren: false
    })
    mocks.removeSubIssue.mockResolvedValueOnce({
      ok: false,
      error: { type: 'network_error', message: 'Network timeout removing #38.' }
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const removeButton = await screen.findByRole('button', { name: /remove #38/i })
    fireEvent.click(removeButton)
    expect(await screen.findByText('Network timeout removing #38.')).toBeInTheDocument()
    expect(mocks.getIssueHierarchy).toHaveBeenCalledTimes(1)
  })

  it('shows an error message when reprioritizeSubIssue resolves ok:false', async () => {
    const mocks = stubApi({
      ok: true,
      parent: null,
      subIssuesSummary: { total: 2, completed: 0, percentCompleted: 0 },
      subIssues: [makeChild({ number: 38 }), makeChild({ number: 39 })],
      hasMoreChildren: false
    })
    mocks.reprioritizeSubIssue.mockResolvedValueOnce({
      ok: false,
      error: { type: 'rate_limited', message: 'Rate limit exceeded, try again later.' }
    })
    render(
      <SubIssuesSection owner="acme" repo="widgets" number={37} editable sourceSettings={null} />
    )
    const moveDown = await screen.findByRole('button', { name: /move #38 down/i })
    fireEvent.click(moveDown)
    expect(await screen.findByText('Rate limit exceeded, try again later.')).toBeInTheDocument()
    expect(mocks.getIssueHierarchy).toHaveBeenCalledTimes(1)
  })
})
