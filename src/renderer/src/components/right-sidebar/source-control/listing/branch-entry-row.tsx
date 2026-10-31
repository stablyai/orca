import React from 'react'
import { MessageSquare } from 'lucide-react'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { writeWorkspaceFileDragSourceForWorkspace } from '@/lib/workspace-file-drag-source'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import { DiffLineCounts } from './diff-line-counts'
import { reviewNoteCountTitle } from './review-note-count-title'
import { SourceControlEntryContextMenu } from './entry-context-menu'
import { toPermanentSourceControlRowOpenEvent, type SourceControlRowOpenEvent } from './split-open'
import {
  getSourceControlRowHighlightClass,
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX
} from './row-layout'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'

export function BranchEntryRow({
  entry,
  currentWorktreeId,
  worktreePath,
  depth = 0,
  isOpenFile = false,
  onRevealInExplorer,
  connectionId,
  onOpen,
  commentCount,
  showPathHint = true
}: {
  entry: GitBranchChangeEntry
  currentWorktreeId: string
  worktreePath: string
  depth?: number
  isOpenFile?: boolean
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  connectionId?: string | null
  onOpen: (event?: SourceControlRowOpenEvent) => void
  commentCount: number
  showPathHint?: boolean
}): React.JSX.Element {
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      relativePath={entry.path}
      hasWorkingTreeFile={entry.status !== 'deleted'}
      connectionId={connectionId}
      onView={() => onOpen()}
      onRevealInExplorer={onRevealInExplorer}
    >
      <div
        data-source-control-path={entry.path}
        data-source-control-area="branch"
        data-current={isOpenFile ? 'true' : undefined}
        className={cn(
          'group flex cursor-pointer items-center gap-1 pr-3 py-1 transition-colors',
          getSourceControlRowHighlightClass(isOpenFile)
        )}
        style={{
          paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
        }}
        draggable
        onDragStart={(e) => {
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, absolutePath)
          writeWorkspaceFileDragSourceForWorkspace(e.dataTransfer, currentWorktreeId)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(e) => onOpen(e)}
        onDoubleClick={(e) => onOpen(toPermanentSourceControlRowOpenEvent(e))}
      >
        {React.createElement(FileTypeIcon, {
          filePath: entry.path,
          className: 'size-3.5 shrink-0',
          style: { color: STATUS_COLORS[entry.status] }
        })}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-foreground">{fileName}</span>
          {showPathHint && dirPath && (
            <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
          )}
        </span>
        {commentCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
            title={reviewNoteCountTitle(commentCount)}
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
