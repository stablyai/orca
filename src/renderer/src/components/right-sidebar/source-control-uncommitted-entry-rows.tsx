import React from 'react'
import {
  ChevronDown,
  Folder,
  FolderOpen,
  MessageSquare,
  Minus,
  Plus,
  Trash,
  Undo2
} from 'lucide-react'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { translate } from '@/i18n/i18n'
import {
  isStageableStatusEntry,
  isSubmoduleWorktreeOnlyChange,
  type DiscardAllArea
} from './discard-all-sequence'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'
import {
  toPermanentSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import { ActionButton } from './source-control-entry-action-button'
import { SourceControlEntryContextMenu } from './source-control-entry-context-menu'
import {
  ConflictBadge,
  DiffLineCounts,
  getLocalizedConflictKindLabel
} from './source-control-entry-badges'
import {
  SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS,
  SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX,
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX
} from './source-control-entry-layout'
import type { SourceControlDirectoryActionPaths } from './source-control-directory-action-paths'
import type { SourceControlTreeDirectoryNode } from './source-control-tree'
import type { GitStatusEntry } from '../../../../shared/types'

type GitStatusSourceControlTreeDirectoryNode = SourceControlTreeDirectoryNode<GitStatusEntry>

function getSubmoduleWorktreeOnlyLabel(): string {
  return translate(
    'auto.components.right.sidebar.SourceControl.5c7a31d8fa',
    'Submodule changes - stage inside submodule'
  )
}

function getSubmoduleWorktreeOnlyStageTooltip(): string {
  return translate(
    'auto.components.right.sidebar.SourceControl.903693db8b',
    'Stage these changes inside the submodule'
  )
}

export function SourceControlTreeDirectoryRow({
  node,
  actionPaths,
  hideBulkActions,
  isExecutingBulk,
  isCollapsed,
  onToggle,
  onRequestDiscardPaths,
  onStagePaths,
  onUnstagePaths
}: {
  node: GitStatusSourceControlTreeDirectoryNode
  actionPaths: SourceControlDirectoryActionPaths
  hideBulkActions: boolean
  isExecutingBulk: boolean
  isCollapsed: boolean
  onToggle: () => void
  onRequestDiscardPaths: (area: DiscardAllArea, paths: readonly string[]) => void
  onStagePaths: (paths: readonly string[]) => Promise<void>
  onUnstagePaths: (paths: readonly string[]) => Promise<void>
}): React.JSX.Element {
  // Why: filtered tree nodes only contain visible descendants. Folder-wide
  // bulk labels would overpromise if they acted on that filtered subset.
  const canStage = !hideBulkActions && actionPaths.stagePaths.length > 0
  const canUnstage = !hideBulkActions && actionPaths.unstagePaths.length > 0
  const canDiscard = !hideBulkActions && actionPaths.discardPaths.length > 0

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
      {(canDiscard || canStage || canUnstage) && (
        <div className={SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS}>
          {canDiscard && (
            <ActionButton
              icon={node.area === 'untracked' ? Trash : Undo2}
              title={
                node.area === 'untracked'
                  ? translate(
                      'auto.components.right.sidebar.SourceControl.9b367363b6',
                      'Delete untracked in folder'
                    )
                  : translate(
                      'auto.components.right.sidebar.SourceControl.6d7f2a47e5',
                      'Discard folder'
                    )
              }
              onClick={(event) => {
                event.stopPropagation()
                onRequestDiscardPaths(node.area, actionPaths.discardPaths)
              }}
              disabled={isExecutingBulk}
            />
          )}
          {canStage && (
            <ActionButton
              icon={Plus}
              title={translate(
                'auto.components.right.sidebar.SourceControl.bfe9011a0e',
                'Stage folder'
              )}
              onClick={(event) => {
                event.stopPropagation()
                void onStagePaths(actionPaths.stagePaths)
              }}
              disabled={isExecutingBulk}
            />
          )}
          {canUnstage && (
            <ActionButton
              icon={Minus}
              title={translate(
                'auto.components.right.sidebar.SourceControl.ab31221779',
                'Unstage folder'
              )}
              onClick={(event) => {
                event.stopPropagation()
                void onUnstagePaths(actionPaths.unstagePaths)
              }}
              disabled={isExecutingBulk}
            />
          )}
        </div>
      )}
    </div>
  )
}

export const UncommittedEntryRow = React.memo(function UncommittedEntryRow({
  entryKey,
  entry,
  currentWorktreeId,
  worktreePath,
  depth = 0,
  selected,
  isOpenFile = false,
  onSelect,
  onContextMenu,
  onRevealInExplorer,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  commentCount,
  showPathHint = true
}: {
  entryKey: string
  entry: GitStatusEntry
  currentWorktreeId: string
  worktreePath: string
  depth?: number
  selected?: boolean
  isOpenFile?: boolean
  onSelect?: (e: React.MouseEvent, key: string, entry: GitStatusEntry) => void
  onContextMenu?: (key: string) => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  onStage: (filePath: string) => Promise<void>
  onUnstage: (filePath: string) => Promise<void>
  onDiscard: (entry: GitStatusEntry) => void
  commentCount: number
  showPathHint?: boolean
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const isResolvedLocally = entry.conflictStatus === 'resolved_locally'
  const isSubmoduleWorktreeOnly = isSubmoduleWorktreeOnlyChange(entry)
  const conflictLabel = entry.conflictKind
    ? getLocalizedConflictKindLabel(entry.conflictKind)
    : null
  // Why: the hint text ("Open and edit…", "Decide whether to…") was removed
  // from the sidebar because it's not actionable here — the user can only
  // click the row, and the conflict-kind label alone is sufficient context.
  // Why: Stage is suppressed for unresolved conflicts because `git add` would
  // immediately erase the `u` record — the only live conflict signal in the
  // sidebar — before the user has actually reviewed the file. The user should
  // resolve in the editor first, then stage from the post-resolution state.
  //
  // Discard is hidden for both unresolved AND resolved_locally rows in v1.
  // For unresolved: discarding is too easy to misfire on a high-risk file.
  // For resolved_locally: discarding can silently re-create the conflict or
  // lose the resolution, and v1 does not have UX to explain this clearly.
  const canDiscard =
    !isUnresolvedConflict &&
    !isResolvedLocally &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  const canStage = isStageableStatusEntry(entry)
  const canUnstage = entry.area === 'staged'

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
      onOpenChange={(open) => {
        if (open && onContextMenu) {
          onContextMenu(entryKey)
        }
      }}
    >
      <div
        data-testid="source-control-entry"
        data-source-control-path={entry.path}
        data-source-control-area={entry.area}
        // Why: the currently open file gets the strongest "current row" accent
        // (full `bg-accent` + `data-current`) per the styleguide, outranking the
        // lighter bulk-selection tint so the open file always reads as active.
        data-current={isOpenFile ? 'true' : undefined}
        className={cn(
          'group relative flex cursor-pointer items-center gap-1 pr-3 py-1 transition-colors',
          isOpenFile ? 'bg-accent hover:bg-accent' : 'hover:bg-accent/40',
          !isOpenFile && selected && 'bg-accent/60'
        )}
        style={{
          paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
        }}
        draggable
        onDragStart={(e) => {
          if (isUnresolvedConflict && entry.status === 'deleted') {
            e.preventDefault()
            return
          }
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, absolutePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(e) => {
          if (onSelect) {
            onSelect(e, entryKey, entry)
          } else {
            onOpen(entry, e)
          }
        }}
        onDoubleClick={(e) => {
          onOpen(entry, toPermanentSourceControlRowOpenEvent(e))
        }}
      >
        <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <div className="min-w-0 flex-1 text-xs">
          <span className="min-w-0 block truncate">
            <span className="text-foreground">{fileName}</span>
            {showPathHint && dirPath && (
              <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
            )}
          </span>
          {(conflictLabel || isSubmoduleWorktreeOnly) && (
            <div className="truncate text-[11px] text-muted-foreground">
              {conflictLabel ?? getSubmoduleWorktreeOnlyLabel()}
            </div>
          )}
        </div>
        {commentCount > 0 && (
          // Why: show a small note marker on any row that has diff notes
          // so the user can tell at a glance which files have review notes
          // attached, without opening the Notes tab.
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
        {entry.conflictStatus ? (
          <ConflictBadge entry={entry} />
        ) : (
          <>
            <DiffLineCounts added={entry.added} removed={entry.removed} />
            <span
              className="w-4 shrink-0 text-center text-[10px] font-bold"
              style={{ color: STATUS_COLORS[entry.status] }}
            >
              {STATUS_LABELS[entry.status]}
            </span>
          </>
        )}
        <div className={SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS}>
          {canDiscard && (
            <ActionButton
              icon={entry.area === 'untracked' ? Trash : Undo2}
              title={
                entry.area === 'untracked'
                  ? translate(
                      'auto.components.right.sidebar.SourceControl.11463f7a98',
                      'Delete untracked file'
                    )
                  : entry.status === 'deleted'
                    ? translate(
                        'auto.components.right.sidebar.SourceControl.989f3d5e34',
                        'Restore file'
                      )
                    : translate(
                        'auto.components.right.sidebar.SourceControl.d54dd48b0b',
                        'Discard changes'
                      )
              }
              onClick={(event) => {
                event.stopPropagation()
                onDiscard(entry)
              }}
            />
          )}
          {(canStage || isSubmoduleWorktreeOnly) && (
            <ActionButton
              icon={Plus}
              title={
                isSubmoduleWorktreeOnly
                  ? getSubmoduleWorktreeOnlyStageTooltip()
                  : translate('auto.components.right.sidebar.SourceControl.8cde1a2fb0', 'Stage')
              }
              onClick={(event) => {
                event.stopPropagation()
                void onStage(entry.path)
              }}
              disabled={isSubmoduleWorktreeOnly}
            />
          )}
          {canUnstage && (
            <ActionButton
              icon={Minus}
              title={translate('auto.components.right.sidebar.SourceControl.df5040e3c3', 'Unstage')}
              onClick={(event) => {
                event.stopPropagation()
                void onUnstage(entry.path)
              }}
            />
          )}
        </div>
      </div>
    </SourceControlEntryContextMenu>
  )
})
