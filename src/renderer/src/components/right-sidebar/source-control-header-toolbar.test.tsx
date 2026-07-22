import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
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

function renderToolbar(
  gitIdentityDisplay: WorktreeGitIdentityDisplay | null = {
    kind: 'branch',
    branchName: 'brennanb2025/source-control-branch-name'
  }
): string {
  return renderToStaticMarkup(
    <SourceControlHeaderToolbar
      gitIdentityDisplay={gitIdentityDisplay}
      filterQuery=""
      filterExpanded={false}
      onFilterQueryChange={vi.fn()}
      onFilterExpandedChange={vi.fn()}
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

describe('SourceControlHeaderToolbar', () => {
  it('renders the truncating branch identity before source control actions', () => {
    const markup = renderToolbar()
    const branchIndex = markup.indexOf('brennanb2025/source-control-branch-name')
    const filterIndex = markup.indexOf('data-testid="source-control-filter-toggle"')

    expect(branchIndex).toBeGreaterThan(-1)
    expect(filterIndex).toBeGreaterThan(branchIndex)
    expect(markup).toContain('aria-label="Current branch: brennanb2025/source-control-branch-name"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('min-w-0 truncate')
    expect(markup).not.toContain('Create PR')
  })

  it('renders detached HEAD in the same identity slot', () => {
    const markup = renderToolbar({
      kind: 'detached',
      shortHead: '8cec248',
      sidebarLabel: 'Detached HEAD @ 8cec248',
      sourceControlLabel: 'Detached HEAD · 8cec248',
      tooltip: 'Detached HEAD at 8cec248. You are viewing a commit, not a branch.'
    })
    const identityIndex = markup.indexOf('Detached HEAD · 8cec248')
    const filterIndex = markup.indexOf('data-testid="source-control-filter-toggle"')

    expect(markup).not.toContain('aria-label="Current branch:')
    expect(identityIndex).toBeGreaterThan(-1)
    expect(filterIndex).toBeGreaterThan(identityIndex)
    expect(markup).toContain(
      'aria-label="Detached HEAD at 8cec248. You are viewing a commit, not a branch."'
    )
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('lucide-git-commit-horizontal')
  })

  it('keeps the identity slot empty until git identity is known', () => {
    const markup = renderToolbar(null)

    expect(markup).not.toContain('aria-label="Current branch:')
    expect(markup).not.toContain('Detached HEAD')
  })
})
