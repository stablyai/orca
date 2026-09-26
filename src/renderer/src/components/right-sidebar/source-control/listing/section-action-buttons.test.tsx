// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { SourceControlBranchSection } from './branch-section'
import { SourceControlUncommittedSections } from './uncommitted-sections'
import type { SourceControlDisplaySection, SourceControlDisplaySectionId } from './section-order'

afterEach(cleanup)

const BRANCH_SUMMARY: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base-oid',
  compareRef: 'feature',
  headOid: 'head-oid',
  mergeBase: 'merge-base-oid',
  changedFiles: 1,
  status: 'ready'
}

const UNSTAGED_ENTRY: GitStatusEntry = {
  path: 'src/app.ts',
  status: 'modified',
  area: 'unstaged'
}

// Sections render collapsed so the assertions see the header actions alone,
// without the virtualized file list.
function renderBranchSection(): void {
  render(
    <TooltipProvider>
      <SourceControlBranchSection
        branchSummary={BRANCH_SUMMARY}
        filteredBranchEntries={[]}
        totalBranchEntryCount={0}
        collapsedSections={new Set(['branch'])}
        toggleSection={vi.fn()}
        sourceControlViewMode="list"
        visibleBranchTreeRows={[]}
        fileListScrollElement={null}
        collapsedTreeDirs={new Set()}
        toggleTreeDir={vi.fn()}
        currentWorktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        revealInExplorer={vi.fn()}
        activeConnectionId={null}
        openCommittedDiff={vi.fn()}
        openBranchAllDiffs={vi.fn()}
        diffCommentCountByPath={new Map()}
      />
    </TooltipProvider>
  )
}

// An unstaged section with one plain entry surfaces Discard all + Stage all
// next to View all — the crowded case the single-line layout has to survive.
function renderUncommittedSections(hasFileVisibilityFilter = false): void {
  const section: SourceControlDisplaySection = {
    id: 'unstaged',
    area: 'unstaged',
    items: [UNSTAGED_ENTRY]
  }
  const unfilteredById = new Map<SourceControlDisplaySectionId, SourceControlDisplaySection>([
    ['unstaged', section]
  ])
  render(
    <TooltipProvider>
      <SourceControlUncommittedSections
        displaySections={[section]}
        unfilteredDisplaySectionsById={unfilteredById}
        normalizedFilter=""
        hasFileVisibilityFilter={hasFileVisibilityFilter}
        collapsedSections={new Set(['unstaged'])}
        toggleSection={vi.fn()}
        onViewSection={vi.fn()}
        isExecutingBulk={false}
        requestDiscardAllInArea={vi.fn()}
        handleStageAllPaths={vi.fn()}
        handleUnstagePaths={vi.fn()}
        sourceControlViewMode="list"
        visibleTreeRowsBySection={{}}
        visibleListRowsBySection={{}}
        fileListScrollElement={null}
        collapsedTreeDirs={new Set()}
        toggleTreeDir={vi.fn()}
        requestDiscardPaths={vi.fn()}
        expandedSubmoduleKeys={new Set()}
        toggleSubmodule={vi.fn()}
        currentWorktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        selectedKeySet={new Set()}
        activeOpenRowKeys={new Set()}
        handleSelect={vi.fn()}
        handleContextMenu={vi.fn()}
        revealInExplorer={vi.fn()}
        activeConnectionId={null}
        handleOpenDiff={vi.fn()}
        handleStage={vi.fn()}
        handleUnstage={vi.fn()}
        requestDiscardEntry={vi.fn()}
        diffCommentCountByPath={new Map()}
      />
    </TooltipProvider>
  )
}

describe('source control section header actions', () => {
  it('groups the uncommitted View all button with the icon actions in one row', () => {
    renderUncommittedSections()

    const viewAll = screen.getByRole('button', { name: 'View all' })
    const discardAll = screen.getByRole('button', { name: 'Discard all' })
    const stageAll = screen.getByRole('button', { name: 'Stage all' })

    // One shared parent, not a sibling of the icon cluster: that grouping is
    // what keeps View all on the icons' line instead of below them.
    expect(viewAll.parentElement).toBe(discardAll.parentElement)
    expect(viewAll.parentElement).toBe(stageAll.parentElement)
    expect(viewAll.parentElement?.className).not.toContain('flex-wrap')
  })

  it('seats the uncommitted action row in a header slot that cannot shrink or wrap', () => {
    renderUncommittedSections()

    const actionsSlot = screen.getByRole('button', { name: 'View all' }).parentElement
      ?.parentElement
    expect(actionsSlot).toHaveClass('shrink-0')
    expect(actionsSlot?.className).not.toContain('flex-wrap')
  })

  it('seats the branch View all button in a header slot that cannot shrink or wrap', () => {
    renderBranchSection()

    const actionsSlot = screen.getByRole('button', { name: 'View all' }).parentElement
    expect(actionsSlot).toHaveClass('shrink-0')
    expect(actionsSlot?.className).not.toContain('flex-wrap')
  })

  it('hides section-wide action buttons while file visibility filters are active', () => {
    renderUncommittedSections(true)
    expect(screen.queryByRole('button', { name: 'Stage all' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard all' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View all' })).toBeInTheDocument()
  })

  it('keeps the View all label on a single line', () => {
    renderBranchSection()

    // Supplied by the shared Button base variant; pinned here so a change to that
    // variant can't silently start wrapping these labels.
    expect(screen.getByRole('button', { name: 'View all' })).toHaveClass('whitespace-nowrap')
  })
})
