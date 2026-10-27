// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { SourceControlUncommittedSections } from './uncommitted-sections'
import type {
  SourceControlDisplaySection,
  SourceControlDisplaySectionId
} from '../../../../../../shared/source-control-section-order'

afterEach(cleanup)

const UNSTAGED_ENTRY: GitStatusEntry = {
  path: 'src/app.ts',
  status: 'modified',
  area: 'unstaged'
}

function renderUncommittedSections({
  sections = [{ id: 'unstaged', area: 'unstaged', items: [UNSTAGED_ENTRY] }],
  handleStageSectionPaths = vi.fn()
}: {
  sections?: SourceControlDisplaySection[]
  handleStageSectionPaths?: (
    sectionId: SourceControlDisplaySectionId,
    paths: readonly string[]
  ) => Promise<void>
} = {}): void {
  const unfilteredById = new Map<SourceControlDisplaySectionId, SourceControlDisplaySection>(
    sections.map((section) => [section.id, section])
  )
  render(
    <TooltipProvider>
      <SourceControlUncommittedSections
        displaySections={sections}
        unfilteredDisplaySectionsById={unfilteredById}
        normalizedFilter=""
        collapsedSections={new Set(sections.map((section) => section.id))}
        toggleSection={vi.fn()}
        onViewSection={vi.fn()}
        isExecutingBulk={false}
        requestDiscardAllInArea={vi.fn()}
        handleStageAllPaths={vi.fn()}
        handleStageSectionPaths={handleStageSectionPaths}
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
  it('includes untracked files in the Changes header Stage all', () => {
    const handleStageSectionPaths = vi.fn(async () => {})
    const changes: SourceControlDisplaySection = {
      id: 'unstaged',
      area: 'unstaged',
      items: [UNSTAGED_ENTRY, { path: 'new.ts', status: 'untracked', area: 'untracked' }]
    }
    renderUncommittedSections({ sections: [changes], handleStageSectionPaths })

    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }))

    expect(handleStageSectionPaths).toHaveBeenCalledWith('unstaged', ['src/app.ts', 'new.ts'])
  })
})
