// @vitest-environment happy-dom
import type React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlChangeScope, SourceControlCommitScopeFiles } from './change-scope'
import type { SourceControlPanelReadyProps } from './panel-props'

const mocks = vi.hoisted(() => {
  const statusProps: { hasFilteredBranchEntries: boolean }[] = []
  return { statusProps }
})

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/source-control/git/git-commit-actions-capability', () => ({
  useGitCommitActionsSupport: () => ({ supported: true })
}))
vi.mock('../listing/content-status', () => ({
  SourceControlContentStatus: (props: { hasFilteredBranchEntries: boolean }) => {
    mocks.statusProps.push(props)
    return null
  }
}))
vi.mock('./commit-surface', () => ({
  SourceControlCommitSurface: () => <div data-testid="commit-surface" />
}))
vi.mock('./fork-push-notice', () => ({ SourceControlForkPushNotice: () => null }))
vi.mock('../listing/uncommitted-sections', () => ({
  SourceControlUncommittedSections: () => <div data-testid="uncommitted-sections" />
}))
vi.mock('../listing/branch-section', () => ({
  branchSectionCountTitle: () => '',
  SourceControlBranchSection: ({
    label,
    sectionKey,
    headerButtonRef,
    children
  }: {
    label: string
    sectionKey: string
    headerButtonRef?: React.Ref<HTMLButtonElement>
    children?: React.ReactNode
  }) => (
    <section data-testid={`section-${sectionKey}`}>
      <button type="button" ref={headerButtonRef}>
        {label}
      </button>
      {children}
    </section>
  )
}))

import { SourceControlPanelContent } from './panel-content'

const COMMIT = { id: 'c1', parentIds: [], subject: 'c1', message: 'c1' }
const COMMIT_SCOPE: SourceControlChangeScope = {
  kind: 'commit',
  commit: COMMIT,
  pickedBaseOid: 'b1',
  pickedFromBranchPage: true
}
const READY_BRANCH = { status: 'ready', baseRef: 'origin/main' }
const BRANCH_ENTRY = { path: 'a.ts', status: 'modified' }

afterEach(() => {
  cleanup()
  mocks.statusProps.length = 0
})

function renderContent(
  changeScope: SourceControlChangeScope,
  commitScopeFiles: SourceControlCommitScopeFiles | null,
  retryCommitScopeFiles = vi.fn()
) {
  const model = {
    branchEntries: [BRANCH_ENTRY],
    branchSummary: READY_BRANCH,
    changeScope,
    collapsedSections: new Set(),
    commitScopeFiles,
    conflictOperation: 'unknown',
    displaySections: [],
    fileFilterState: { tooLarge: false },
    filterQuery: '',
    filteredBranchEntries: changeScope.kind === 'all' ? [BRANCH_ENTRY] : [],
    hasUncommittedEntries: false,
    normalizedFilter: '',
    retryCommitScopeFiles,
    unresolvedConflictReviewEntries: [],
    unresolvedConflicts: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the content reads only the fields above for these scopes.
  const props = {
    activeWorktree: { pushTarget: null },
    currentWorktreeId: 'wt-1',
    worktreePath: '/repo',
    model
  } as unknown as SourceControlPanelReadyProps
  return render(<SourceControlPanelContent {...props} />)
}

describe('SourceControlPanelContent commit scope', () => {
  it('shows the commit Files section in place of the branch list and commit surface', () => {
    renderContent(COMMIT_SCOPE, { commitId: 'c1', status: 'loading' })
    expect(screen.getByTestId('section-commit')).toBeTruthy()
    expect(screen.queryByTestId('section-branch')).toBeNull()
    expect(screen.queryByTestId('commit-surface')).toBeNull()
    // Files still loading must not read as "No matching files".
    expect(mocks.statusProps.at(-1)?.hasFilteredBranchEntries).toBe(true)
  })

  it('keeps the branch list and commit surface under All changes', () => {
    renderContent({ kind: 'all' }, null)
    expect(screen.getByTestId('section-branch')).toBeTruthy()
    expect(screen.getByTestId('commit-surface')).toBeTruthy()
    expect(screen.queryByTestId('section-commit')).toBeNull()
  })

  it('moves focus from Retry to the Files header once a retry succeeds', () => {
    const retry = vi.fn<(onReady: () => void) => void>()
    renderContent(COMMIT_SCOPE, { commitId: 'c1', status: 'error', error: 'boom' }, retry)
    const button = screen.getByRole('button', { name: 'Retry' })
    button.focus()
    fireEvent.click(button)
    expect(retry).toHaveBeenCalledTimes(1)
    act(() => retry.mock.calls[0][0]())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Files' }))
  })

  it('leaves focus alone when the user moved on before the retry succeeded', () => {
    const retry = vi.fn<(onReady: () => void) => void>()
    renderContent(COMMIT_SCOPE, { commitId: 'c1', status: 'error', error: 'boom' }, retry)
    const button = screen.getByRole('button', { name: 'Retry' })
    button.focus()
    fireEvent.click(button)
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    act(() => retry.mock.calls[0][0]())
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})
