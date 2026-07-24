import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type { PrimaryAction } from './source-control-primary-action'
import { SourceControlHeaderToolbar } from './source-control-header-toolbar'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./source-control-header-overflow-menu', () => ({
  SourceControlHeaderOverflowMenu: () => <button type="button">More actions</button>
}))

vi.mock('./source-control-branch-context-row', () => ({
  shouldShowSourceControlBranchContextRow: () => false,
  SourceControlBranchContextRow: () => null
}))

const CREATE_PR_ACTION: PrimaryAction = {
  kind: 'create_pr',
  label: 'Create PR',
  title: 'Create a pull request',
  disabled: false
}

function renderToolbar(
  overrides: {
    gitIdentityDisplay?: WorktreeGitIdentityDisplay | null
    createPrAction?: PrimaryAction | null
  } = {}
): string {
  const gitIdentityDisplay =
    overrides.gitIdentityDisplay === undefined
      ? ({ kind: 'branch', branchName: 'brennanb2025/source-control-branch-name' } as const)
      : overrides.gitIdentityDisplay
  const createPrAction =
    overrides.createPrAction === undefined ? CREATE_PR_ACTION : overrides.createPrAction

  return renderToStaticMarkup(
    <SourceControlHeaderToolbar
      gitIdentityDisplay={gitIdentityDisplay}
      filterQuery=""
      filterExpanded={false}
      onFilterQueryChange={vi.fn()}
      onFilterExpandedChange={vi.fn()}
      visibleCreatePrHeaderAction={createPrAction}
      hostedReview={null}
      isCreatePrIntentInFlight={false}
      isCreatingPr={false}
      onCreatePrHeaderClick={vi.fn()}
      onOpenHostedReviewInChecks={vi.fn()}
      sourceControlViewMode="list"
      viewModeToggleDisabled={false}
      onToggleViewMode={vi.fn()}
      onChangeBaseRef={vi.fn()}
      onRefreshBranchCompare={vi.fn()}
      branchCompareRefreshDisabled={false}
      diffCommentCount={0}
      onExpandNotes={vi.fn()}
      branchSummary={null}
      compareBaseRef={null}
    />
  )
}

describe('SourceControlHeaderToolbar branch identity', () => {
  it('keeps the Create PR button while showing the branch identity above it', () => {
    const markup = renderToolbar()
    const branchIndex = markup.indexOf('brennanb2025/source-control-branch-name')
    const createPrIndex = markup.indexOf('Create PR')

    // Why: the #9787 revert regression — identity must not evict Create PR.
    expect(markup).toContain('data-testid="source-control-git-identity-row"')
    expect(branchIndex).toBeGreaterThan(-1)
    expect(createPrIndex).toBeGreaterThan(-1)
    // Identity row renders above the toolbar row that hosts Create PR.
    expect(branchIndex).toBeLessThan(createPrIndex)
    expect(markup).toContain('aria-label="Current branch: brennanb2025/source-control-branch-name"')
    expect(markup).toContain('min-w-0 truncate')
  })

  it('renders detached HEAD identity alongside the Create PR button', () => {
    const markup = renderToolbar({
      gitIdentityDisplay: {
        kind: 'detached',
        shortHead: '8cec248',
        sidebarLabel: 'Detached HEAD @ 8cec248',
        sourceControlLabel: 'Detached HEAD · 8cec248',
        tooltip: 'Detached HEAD at 8cec248. You are viewing a commit, not a branch.'
      }
    })

    expect(markup).not.toContain('aria-label="Current branch:')
    expect(markup).toContain('data-testid="source-control-git-identity-row"')
    expect(markup).toContain('Detached HEAD · 8cec248')
    // Detached badge stays keyboard-reachable and exposes the full tooltip as its label.
    expect(markup).toContain(
      'aria-label="Detached HEAD at 8cec248. You are viewing a commit, not a branch."'
    )
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('Create PR')
  })

  it('omits the identity row when there is no git identity', () => {
    const markup = renderToolbar({ gitIdentityDisplay: null })

    expect(markup).not.toContain('data-testid="source-control-git-identity-row"')
    expect(markup).not.toContain('aria-label="Current branch:')
    expect(markup).toContain('Create PR')
  })
})
