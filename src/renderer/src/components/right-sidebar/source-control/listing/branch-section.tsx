import React, { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { SourceControlTreeNode } from '../../../../../../shared/source-control/listing/source-control-tree'
import type { SourceControlRowOpenEvent } from './split-open'
import { BranchEntryRow } from './branch-entry-row'
import { SectionHeader } from './section-header'
import { formatSourceControlRefLabel } from '../panel/branch-context-stats'
import { SourceControlBranchTreeDirectoryRow } from './tree-directory-rows'
import { VirtualizedList } from '../../../virtualized-list'
import { MergedBranchChip } from './merged-branch-chip'
import { useMergedBranchSectionDisclosure } from './use-merged-branch-section-disclosure'

export function SourceControlBranchSection({
  activeOpenRowKeys,
  branchSummary,
  filteredBranchEntries,
  totalBranchEntryCount,
  collapsedSections,
  toggleSection,
  setBranchSectionCollapsed,
  review,
  statusHeadOid,
  uncommittedCount,
  isMainWorktree,
  isBranchDiffEditorActive,
  sourceControlViewMode,
  visibleBranchTreeRows,
  fileListScrollElement,
  collapsedTreeDirs,
  toggleTreeDir,
  currentWorktreeId,
  worktreePath,
  revealInExplorer,
  activeConnectionId,
  openCommittedDiff,
  openBranchAllDiffs,
  diffCommentCountByPath
}: {
  activeOpenRowKeys: ReadonlySet<string>
  branchSummary: GitBranchCompareSummary
  filteredBranchEntries: GitBranchChangeEntry[]
  totalBranchEntryCount: number
  collapsedSections: Set<string>
  toggleSection: (section: string) => void
  setBranchSectionCollapsed: (collapsed: boolean) => void
  /** Null for folder workspaces and branches without a review. */
  review: HostedReviewInfo | null
  /** HEAD from the latest successful status read; null while unknown. */
  statusHeadOid: string | null
  uncommittedCount: number
  isMainWorktree: boolean
  isBranchDiffEditorActive: boolean
  sourceControlViewMode: SourceControlViewMode
  visibleBranchTreeRows: readonly SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[]
  fileListScrollElement: HTMLDivElement | null
  collapsedTreeDirs: Set<string>
  toggleTreeDir: (key: string) => void
  currentWorktreeId: string
  worktreePath: string
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
  activeConnectionId: string | null
  openCommittedDiff: (entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => void
  openBranchAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    summary: GitBranchCompareSummary
  ) => void
  diffCommentCountByPath: Map<string, number>
}): React.JSX.Element {
  const t = useTranslate()
  const baseRef = branchSummary.baseRef?.trim()
  const fileCount = filteredBranchEntries.length
  // Counts measure current base differences, not historical touches; omit the total label when filters narrow the list.
  const countTitle =
    baseRef && fileCount === totalBranchEntryCount
      ? t(
          'auto.components.right.sidebar.SourceControl.branchFilesChangedVsBase',
          '{{count}} files changed vs {{ref}}',
          {
            count: fileCount,
            ref: formatSourceControlRefLabel(baseRef),
            defaultValue_one: '{{count}} file changed vs {{ref}}'
          }
        )
      : undefined

  const sectionRef = useRef<HTMLDivElement | null>(null)
  const { mergedReview } = useMergedBranchSectionDisclosure({
    worktreeId: currentWorktreeId,
    isMainWorktree,
    review,
    statusHeadOid,
    uncommittedCount,
    branchDiffEditorActive: isBranchDiffEditorActive,
    setBranchSectionCollapsed,
    sectionRef
  })

  return (
    <div ref={sectionRef}>
      <SectionHeader
        label={t('auto.components.right.sidebar.SourceControl.d7ae61269b', 'Committed on Branch')}
        count={fileCount}
        countTitle={countTitle}
        status={mergedReview ? <MergedBranchChip review={mergedReview} /> : undefined}
        isCollapsed={collapsedSections.has('branch')}
        onToggle={() => toggleSection('branch')}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="px-1.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (currentWorktreeId && worktreePath && branchSummary) {
                openBranchAllDiffs(currentWorktreeId, worktreePath, branchSummary)
              }
            }}
          >
            {t('auto.components.right.sidebar.SourceControl.48db37cca9', 'View all')}
          </Button>
        }
      />
      {!collapsedSections.has('branch') &&
        (sourceControlViewMode === 'tree' ? (
          <VirtualizedList
            rows={visibleBranchTreeRows}
            scrollElement={fileListScrollElement}
            getRowKey={(node) => node.key}
            renderRow={(node) => {
              if (node.type === 'directory') {
                return (
                  <SourceControlBranchTreeDirectoryRow
                    key={node.key}
                    node={node}
                    isCollapsed={collapsedTreeDirs.has(node.key)}
                    onToggle={() => toggleTreeDir(node.key)}
                  />
                )
              }
              return (
                <BranchEntryRow
                  key={node.key}
                  entry={node.entry}
                  currentWorktreeId={currentWorktreeId}
                  worktreePath={worktreePath}
                  depth={node.depth}
                  isOpenFile={activeOpenRowKeys.has(node.key)}
                  onRevealInExplorer={revealInExplorer}
                  connectionId={activeConnectionId}
                  onOpen={(event) => openCommittedDiff(node.entry, event)}
                  commentCount={diffCommentCountByPath.get(node.entry.path) ?? 0}
                  showPathHint={false}
                />
              )
            }}
          />
        ) : (
          <VirtualizedList
            rows={filteredBranchEntries}
            scrollElement={fileListScrollElement}
            getRowKey={(entry) => `branch::${entry.path}`}
            renderRow={(entry) => (
              <BranchEntryRow
                key={`branch::${entry.path}`}
                isOpenFile={activeOpenRowKeys.has(`branch::${entry.path}`)}
                entry={entry}
                currentWorktreeId={currentWorktreeId}
                worktreePath={worktreePath}
                onRevealInExplorer={revealInExplorer}
                connectionId={activeConnectionId}
                onOpen={(event) => openCommittedDiff(entry, event)}
                commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
              />
            )}
          />
        ))}
    </div>
  )
}
