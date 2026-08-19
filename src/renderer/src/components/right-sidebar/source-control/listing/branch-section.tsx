import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type { SourceControlTreeNode } from '../../source-control-tree'
import type { SourceControlRowOpenEvent } from './split-open'
import { BranchEntryRow } from './branch-entry-row'
import { SectionHeader } from './section-header'
import { SourceControlBranchTreeDirectoryRow } from './tree-directory-rows'
import { SourceControlVirtualFileList } from './virtual-file-list'

export function SourceControlBranchSection({
  branchSummary,
  filteredBranchEntries,
  collapsedSections,
  toggleSection,
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
  branchSummary: GitBranchCompareSummary
  filteredBranchEntries: GitBranchChangeEntry[]
  collapsedSections: Set<string>
  toggleSection: (section: string) => void
  sourceControlViewMode: SourceControlViewMode
  visibleBranchTreeRows: SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[]
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
  return (
    <div>
      <SectionHeader
        label={translate(
          'auto.components.right.sidebar.SourceControl.d7ae61269b',
          'Committed on Branch'
        )}
        count={filteredBranchEntries.length}
        isCollapsed={collapsedSections.has('branch')}
        onToggle={() => toggleSection('branch')}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              if (currentWorktreeId && worktreePath && branchSummary) {
                openBranchAllDiffs(currentWorktreeId, worktreePath, branchSummary)
              }
            }}
          >
            {translate('auto.components.right.sidebar.SourceControl.48db37cca9', 'View all')}
          </Button>
        }
      />
      {!collapsedSections.has('branch') &&
        (sourceControlViewMode === 'tree' ? (
          <SourceControlVirtualFileList
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
          <SourceControlVirtualFileList
            rows={filteredBranchEntries}
            scrollElement={fileListScrollElement}
            getRowKey={(entry) => `branch:${entry.path}`}
            renderRow={(entry) => (
              <BranchEntryRow
                key={`branch:${entry.path}`}
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
