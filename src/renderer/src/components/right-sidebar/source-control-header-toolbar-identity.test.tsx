import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlHeaderToolbar } from './source-control-header-toolbar'
import type { GitBranchCompareSummary } from '../../../../shared/types'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type { PrimaryAction } from './source-control-primary-action'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./source-control-header-overflow-menu', () => ({
  SourceControlHeaderOverflowMenu: () => <button type="button">More actions</button>
}))

const CREATE_PR_ACTION: PrimaryAction = {
  kind: 'create_pr',
  label: 'Create PR',
  title: 'Create a pull request',
  disabled: false
}

const readySummary: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 0,
  commitsAhead: 1,
  status: 'ready'
}

function renderToolbar(options?: {
  headDisplay?: WorktreeGitIdentityDisplay | null
  branchSummary?: GitBranchCompareSummary | null
  compareBaseRef?: string | null
}): string {
  return renderToStaticMarkup(
    <SourceControlHeaderToolbar
      filterQuery=""
      filterExpanded={false}
      onFilterQueryChange={vi.fn()}
      onFilterExpandedChange={vi.fn()}
      visibleCreatePrHeaderAction={CREATE_PR_ACTION}
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
      branchSummary={options?.branchSummary === undefined ? readySummary : options.branchSummary}
      compareBaseRef={options?.compareBaseRef === undefined ? null : options.compareBaseRef}
      headDisplay={
        options?.headDisplay === undefined
          ? { kind: 'branch', branchName: 'brennanb2025/source-control-branch-name' }
          : options.headDisplay
      }
    />
  )
}

describe('SourceControlHeaderToolbar branch identity', () => {
  it('keeps Create PR while stacking head above base in the context row', () => {
    const markup = renderToolbar()
    const branchIndex = markup.indexOf('brennanb2025/source-control-branch-name')
    const createPrIndex = markup.indexOf('Create PR')

    // Why: the #9787 regression — identity must not evict Create PR.
    expect(branchIndex).toBeGreaterThan(-1)
    expect(createPrIndex).toBeGreaterThan(-1)
    expect(markup).toContain('aria-label="brennanb2025/source-control-branch-name → origin/main"')
    expect(markup).toContain('aria-label="Current branch: brennanb2025/source-control-branch-name"')
    expect(markup).toContain('data-testid="source-control-head-identity"')
  })

  it('shows head-only identity with Create PR when no compare base is configured', () => {
    const markup = renderToolbar({
      branchSummary: null,
      compareBaseRef: null,
      headDisplay: { kind: 'branch', branchName: 'local-only-branch' }
    })

    expect(markup).toContain('Create PR')
    expect(markup).toContain('data-testid="source-control-head-identity"')
    expect(markup).toContain('local-only-branch')
    expect(markup).not.toContain('→')
  })

  it('renders detached HEAD with Create PR when compare base is present', () => {
    const markup = renderToolbar({
      headDisplay: {
        kind: 'detached',
        shortHead: '8cec248',
        sidebarLabel: 'Detached HEAD @ 8cec248',
        sourceControlLabel: 'Detached HEAD · 8cec248',
        tooltip: 'Detached HEAD at 8cec248. You are viewing a commit, not a branch.'
      }
    })

    expect(markup).toContain('Detached HEAD · 8cec248')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('Create PR')
    expect(markup).toContain('aria-label="Detached HEAD · 8cec248 → origin/main"')
  })

  it('omits identity chrome when there is no git identity and no base', () => {
    const markup = renderToolbar({
      headDisplay: null,
      branchSummary: null,
      compareBaseRef: null
    })

    expect(markup).not.toContain('data-testid="source-control-head-identity"')
    expect(markup).not.toContain('→')
    expect(markup).toContain('Create PR')
  })
})
