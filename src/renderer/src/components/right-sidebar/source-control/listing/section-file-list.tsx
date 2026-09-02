import React from 'react'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type { DiscardAllArea } from '../commit/discard-all-sequence'
import {
  getSubmoduleExpansionKey,
  isExpandableSubmoduleEntry,
  type RenderableSourceControlNode,
  type RenderableSubmoduleListItem
} from './submodule-expansion'
import type { SourceControlRowOpenEvent } from './split-open'
import { getSourceControlDirectoryActionPaths } from './directory-action-paths'
import { SourceControlTreeDirectoryRow } from './tree-directory-rows'
import { SubmodulePlaceholderRow } from './submodule-placeholder-row'
import { UncommittedEntryRow } from './uncommitted-entry-row'
import { SourceControlVirtualFileList } from './virtual-file-list'

export function SourceControlSectionFileList({
  sourceControlViewMode,
  treeRows,
  listRows,
  fileListScrollElement,
  normalizedFilter,
  isExecutingBulk,
  collapsedTreeDirs,
  toggleTreeDir,
  requestDiscardPaths,
  handleStageAllPaths,
  handleUnstagePaths,
  expandedSubmoduleKeys,
  toggleSubmodule,
  currentWorktreeId,
  worktreePath,
  selectedKeySet,
  activeOpenRowKeys,
  handleSelect,
  handleContextMenu,
  revealInExplorer,
  activeConnectionId,
  handleOpenDiff,
  handleStage,
  handleUnstage,
  requestDiscardEntry,
  diffCommentCountByPath
}: {
  sourceControlViewMode: SourceControlViewMode
  treeRows: RenderableSourceControlNode[]
  listRows: RenderableSubmoduleListItem[]
  fileListScrollElement: HTMLDivElement | null
  normalizedFilter: string
  isExecutingBulk: boolean
  collapsedTreeDirs: Set<string>
  toggleTreeDir: (key: string) => void
  requestDiscardPaths: (area: DiscardAllArea, paths: readonly string[]) => void
  handleStageAllPaths: (paths: readonly string[]) => Promise<void>
  handleUnstagePaths: (paths: readonly string[]) => Promise<void>
  expandedSubmoduleKeys: Set<string>
  toggleSubmodule: (entry: Pick<GitStatusEntry, 'area' | 'path'>) => void
  currentWorktreeId: string
  worktreePath: string
  selectedKeySet: ReadonlySet<string>
  activeOpenRowKeys: ReadonlySet<string>
  handleSelect: (event: React.MouseEvent, key: string, entry: GitStatusEntry) => void
  handleContextMenu: (key: string) => void
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
  activeConnectionId: string | null
  handleOpenDiff: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  handleStage: (path: string) => Promise<void>
  handleUnstage: (path: string) => Promise<void>
  requestDiscardEntry: (entry: GitStatusEntry) => void
  diffCommentCountByPath: Map<string, number>
}): React.JSX.Element {
  return sourceControlViewMode === 'tree' ? (
    <SourceControlVirtualFileList
      rows={treeRows}
      scrollElement={fileListScrollElement}
      getRowKey={(node) => node.key}
      renderRow={(node) => {
        if (node.type === 'submodule-placeholder') {
          return (
            <SubmodulePlaceholderRow
              key={node.key}
              depth={node.depth}
              state={node.state}
              message={node.message}
            />
          )
        }
        if (node.type === 'directory') {
          return (
            <SourceControlTreeDirectoryRow
              key={node.key}
              node={node}
              actionPaths={getSourceControlDirectoryActionPaths(node)}
              hideBulkActions={Boolean(normalizedFilter)}
              isExecutingBulk={isExecutingBulk}
              isCollapsed={collapsedTreeDirs.has(node.key)}
              onToggle={() => toggleTreeDir(node.key)}
              onRequestDiscardPaths={requestDiscardPaths}
              onStagePaths={handleStageAllPaths}
              onUnstagePaths={handleUnstagePaths}
            />
          )
        }
        const submoduleExpansion = isExpandableSubmoduleEntry(node.entry)
          ? {
              isExpanded: expandedSubmoduleKeys.has(getSubmoduleExpansionKey(node.entry)),
              onToggle: () => toggleSubmodule(node.entry)
            }
          : undefined
        return (
          <UncommittedEntryRow
            key={node.key}
            entryKey={node.key}
            entry={node.entry}
            currentWorktreeId={currentWorktreeId}
            worktreePath={worktreePath}
            depth={node.depth}
            selected={selectedKeySet.has(node.key)}
            isOpenFile={activeOpenRowKeys.has(node.key)}
            onSelect={handleSelect}
            onContextMenu={handleContextMenu}
            onRevealInExplorer={revealInExplorer}
            connectionId={activeConnectionId}
            onOpen={handleOpenDiff}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onDiscard={requestDiscardEntry}
            commentCount={diffCommentCountByPath.get(node.entry.path) ?? 0}
            showPathHint={false}
            submoduleExpansion={submoduleExpansion}
          />
        )
      }}
    />
  ) : (
    <SourceControlVirtualFileList
      rows={listRows}
      scrollElement={fileListScrollElement}
      getRowKey={(row) =>
        row.type === 'submodule-placeholder' ? row.key : `${row.entry.area}::${row.entry.path}`
      }
      renderRow={(row) => {
        if (row.type === 'submodule-placeholder') {
          return (
            <SubmodulePlaceholderRow
              key={row.key}
              depth={row.depth}
              state={row.state}
              message={row.message}
            />
          )
        }
        const entry = row.entry
        const key = `${entry.area}::${entry.path}`
        const submoduleExpansion = isExpandableSubmoduleEntry(entry)
          ? {
              isExpanded: expandedSubmoduleKeys.has(getSubmoduleExpansionKey(entry)),
              onToggle: () => toggleSubmodule(entry)
            }
          : undefined
        return (
          <UncommittedEntryRow
            key={key}
            entryKey={key}
            entry={entry}
            currentWorktreeId={currentWorktreeId}
            worktreePath={worktreePath}
            depth={entry.submoduleRoot ? 1 : 0}
            selected={selectedKeySet.has(key)}
            isOpenFile={activeOpenRowKeys.has(key)}
            onSelect={handleSelect}
            onContextMenu={handleContextMenu}
            onRevealInExplorer={revealInExplorer}
            connectionId={activeConnectionId}
            onOpen={handleOpenDiff}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onDiscard={requestDiscardEntry}
            commentCount={diffCommentCountByPath.get(entry.path) ?? 0}
            submoduleExpansion={submoduleExpansion}
          />
        )
      }}
    />
  )
}
