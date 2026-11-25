import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import type { SourceControlTreeNode } from '../../../../../../shared/source-control/listing/source-control-tree'
import type { SourceControlRowOpenEvent } from './split-open'
import { BranchEntryRow } from './branch-entry-row'
import { SectionHeader } from './section-header'
import { formatSourceControlRefLabel } from '../panel/branch-context-stats'
import { SourceControlBranchTreeDirectoryRow } from './tree-directory-rows'
import { VirtualizedList } from '../../../ui/virtualized-list'

/** Count title for Committed on Branch: what its file count measures against the compare base. */
export function branchSectionCountTitle(
  t: Translate,
  branchSummary: GitBranchCompareSummary,
  fileCount: number,
  totalBranchEntryCount: number
): string | undefined {
  const baseRef = branchSummary.baseRef?.trim()
  // Counts measure current base differences, not historical touches; omit the total label when filters narrow the list.
  return baseRef && fileCount === totalBranchEntryCount
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
}

/** A committed-files section: Committed on Branch, or the files of a picked commit. */
export function SourceControlBranchSection({
  label,
  countTitle,
  sectionKey,
  onViewAll,
  activeOpenRowKeys,
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
  openEntry,
  diffCommentCountByPath,
  headerButtonRef,
  children
}: {
  label: string
  countTitle?: string
  /** Collapse-state key; the commit view keeps its own so it never inherits Committed on Branch's. */
  sectionKey: 'branch' | 'commit'
  onViewAll?: () => void
  activeOpenRowKeys: ReadonlySet<string>
  filteredBranchEntries: GitBranchChangeEntry[]
  collapsedSections: Set<string>
  toggleSection: (section: string) => void
  sourceControlViewMode: SourceControlViewMode
  visibleBranchTreeRows: readonly SourceControlTreeNode<GitBranchChangeEntry, 'branch'>[]
  fileListScrollElement: HTMLDivElement | null
  collapsedTreeDirs: Set<string>
  toggleTreeDir: (key: string) => void
  currentWorktreeId: string
  worktreePath: string
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
  activeConnectionId: string | null
  openEntry: (entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => void
  diffCommentCountByPath: Map<string, number>
  headerButtonRef?: React.Ref<HTMLButtonElement>
  /** Replaces the rows, for loading/error/empty states. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const fileCount = filteredBranchEntries.length
  const collapsed = collapsedSections.has(sectionKey)

  return (
    <div>
      <SectionHeader
        label={label}
        count={fileCount}
        countTitle={countTitle}
        buttonRef={headerButtonRef}
        isCollapsed={collapsed}
        onToggle={() => toggleSection(sectionKey)}
        actions={
          onViewAll ? (
            <Button
              type="button"
              variant="muted-field-icon"
              size="xs"
              onClick={(e) => {
                e.stopPropagation()
                onViewAll()
              }}
            >
              {t('auto.components.right.sidebar.SourceControl.48db37cca9', 'View all')}
            </Button>
          ) : undefined
        }
      />
      {!collapsed &&
        (children ??
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
                    onOpen={(event) => openEntry(node.entry, event)}
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
                  onOpen={(event) => openEntry(entry, event)}
                  commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
                />
              )}
            />
          )))}
    </div>
  )
}
