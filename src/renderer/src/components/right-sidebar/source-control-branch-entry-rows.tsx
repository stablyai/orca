import React from 'react'
import { ChevronDown, Folder, FolderOpen, MessageSquare } from 'lucide-react'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { translate } from '@/i18n/i18n'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'
import {
  toPermanentSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import { SourceControlEntryContextMenu } from './source-control-entry-context-menu'
import { DiffLineCounts } from './source-control-entry-badges'
import {
  SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX,
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX
} from './source-control-entry-layout'
import type { SourceControlTreeDirectoryNode } from './source-control-tree'
import type { GitBranchChangeEntry } from '../../../../shared/types'

type BranchSourceControlTreeDirectoryNode = SourceControlTreeDirectoryNode<
  GitBranchChangeEntry,
  'branch'
>

export function SourceControlBranchTreeDirectoryRow({
  node,
  isCollapsed,
  onToggle
}: {
  node: BranchSourceControlTreeDirectoryNode
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div
      className="group relative flex w-full items-center gap-1 pr-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      style={{
        paddingLeft: `${node.depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX}px`
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
      >
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
        />
        {isCollapsed ? (
          <Folder className="size-3 shrink-0" />
        ) : (
          <FolderOpen className="size-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      <span className="w-4 shrink-0 text-center text-[10px] font-bold tabular-nums text-muted-foreground/80">
        {node.fileCount}
      </span>
    </div>
  )
}

export function BranchEntryRow({
  entry,
  currentWorktreeId,
  worktreePath,
  depth = 0,
  onRevealInExplorer,
  onOpen,
  commentCount,
  showPathHint = true
}: {
  entry: GitBranchChangeEntry
  currentWorktreeId: string
  worktreePath: string
  depth?: number
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: (event: SourceControlRowOpenEvent) => void
  commentCount: number
  showPathHint?: boolean
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
    >
      <div
        className="group flex cursor-pointer items-center gap-1 pr-3 py-1 transition-colors hover:bg-accent/40"
        style={{
          paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
        }}
        draggable
        onDragStart={(e) => {
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, absolutePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(e) => onOpen(e)}
        onDoubleClick={(e) => onOpen(toPermanentSourceControlRowOpenEvent(e))}
      >
        <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-foreground">{fileName}</span>
          {showPathHint && dirPath && (
            <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
          )}
        </span>
        {commentCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title={translate(
              'auto.components.right.sidebar.SourceControl.657e0c90ad',
              '{{value0}} note{{value1}}',
              { value0: commentCount, value1: commentCount === 1 ? '' : 's' }
            )}
          >
            <MessageSquare className="size-3" />
            <span className="tabular-nums">{commentCount}</span>
          </span>
        )}
        <DiffLineCounts added={entry.added} removed={entry.removed} />
        <span
          className="w-4 shrink-0 text-center text-[10px] font-bold"
          style={{ color: STATUS_COLORS[entry.status] }}
        >
          {STATUS_LABELS[entry.status]}
        </span>
      </div>
    </SourceControlEntryContextMenu>
  )
}
