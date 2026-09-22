import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlBranchSection } from './source-control/listing/branch-section'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'

const readySummary: GitBranchCompareSummary = {
  baseRef: 'refs/remotes/origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 4,
  commitsAhead: 5,
  status: 'ready'
}

function render(
  summary: GitBranchCompareSummary,
  fileCount = 4,
  totalBranchEntryCount = fileCount
): string {
  return renderToStaticMarkup(
    <SourceControlBranchSection
      branchSummary={summary}
      filteredBranchEntries={Array.from({ length: fileCount }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'modified'
      }))}
      totalBranchEntryCount={totalBranchEntryCount}
      // Collapsed: the heading is the subject here, not the virtualized list.
      collapsedSections={new Set(['branch'])}
      toggleSection={vi.fn()}
      sourceControlViewMode="list"
      visibleBranchTreeRows={[]}
      fileListScrollElement={null}
      collapsedTreeDirs={new Set()}
      toggleTreeDir={vi.fn()}
      currentWorktreeId="wt-1"
      worktreePath={join(tmpdir(), 'wt-1')}
      revealInExplorer={vi.fn()}
      activeConnectionId={null}
      openCommittedDiff={vi.fn()}
      openBranchAllDiffs={vi.fn()}
      diffCommentCountByPath={new Map()}
    />
  )
}

describe('SourceControlBranchSection heading', () => {
  // The heading counts files that differ from the compare base, not every file
  // the branch ever touched — a rebased branch makes those read alike.
  it('names the compare base on the count, leaving the heading text alone', () => {
    const markup = render(readySummary)

    expect(markup).toContain('Committed on Branch')
    expect(markup).toContain('title="4 files changed vs origin/main"')
    // No aria-label: inside the section toggle button it would rewrite the
    // button's accessible name ("Committed on Branch 4 files changed vs …").
    expect(markup).not.toContain('aria-label="4 files changed vs origin/main"')
  })

  it('uses the singular count label for one file', () => {
    expect(render(readySummary, 1)).toContain('title="1 file changed vs origin/main"')
  })

  // A narrowing filter changes what the number means: 2 matching files are not
  // "2 files changed vs origin/main", so the label must go silent.
  it('leaves the count unlabelled while a filter narrows the list', () => {
    expect(render(readySummary, 2, 4)).not.toContain('files changed vs')
  })

  it('leaves the count unlabelled when the summary has no base ref', () => {
    const markup = render({ ...readySummary, baseRef: '  ' })

    expect(markup).toContain('Committed on Branch')
    expect(markup).not.toContain('files changed vs')
  })
})
