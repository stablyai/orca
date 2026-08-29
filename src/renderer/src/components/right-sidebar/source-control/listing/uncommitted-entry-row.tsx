import React from 'react'
import { ChevronDown, MessageSquare, Minus, Plus, Trash, Undo2 } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { ActionButton } from './action-button'
import { ConflictBadge } from './conflict-badge'
import { getLocalizedConflictKindLabel } from './conflict-label'
import { DiffLineCounts } from './diff-line-counts'
import { SourceControlEntryContextMenu } from './entry-context-menu'
import { canDiscardStatusEntry, canStageStatusEntry, canUnstageStatusEntry } from './entry-actions'
import { isSubmoduleWorktreeOnlyChange } from '../commit/discard-all-sequence'
import { toPermanentSourceControlRowOpenEvent, type SourceControlRowOpenEvent } from './split-open'
import {
  SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS,
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX,
  SUBMODULE_WORKTREE_ONLY_LABEL,
  SUBMODULE_WORKTREE_ONLY_TOOLTIP
} from './row-layout'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'

/**
 * Renders one uncommitted change row: file identity, conflict/diff badges, and the hover actions
 * (discard, stage, unstage) that the entry's own state permits.
 *
 * Clicking opens the file unless `onSelect` claims the click for bulk selection, or the row is a
 * dirty submodule, in which case it toggles `submoduleExpansion` instead.
 */
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
  connectionId,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  commentCount,
  showPathHint = true,
  submoduleExpansion
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
  connectionId?: string | null
  onOpen: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  onStage: (filePath: string) => Promise<void>
  onUnstage: (filePath: string) => Promise<void>
  onDiscard: (entry: GitStatusEntry) => void
  commentCount: number
  showPathHint?: boolean
  // When set, the row is a dirty submodule: clicking toggles lazy expansion instead of opening an uninformative gitlink diff.
  submoduleExpansion?: { isExpanded: boolean; onToggle: () => void }
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const isSubmoduleWorktreeOnly = isSubmoduleWorktreeOnlyChange(entry)
  const conflictLabel = entry.conflictKind
    ? getLocalizedConflictKindLabel(entry.conflictKind)
    : null
  // Why: Stage is suppressed for unresolved conflicts because `git add` erases the `u` record (the only live conflict signal) before review.
  // Why: Discard is hidden for unresolved (too easy to misfire) and resolved_locally (can silently re-create the conflict or lose the resolution) rows in v1.
  const canDiscard = canDiscardStatusEntry(entry)
  const canStage = canStageStatusEntry(entry)
  // Why: a submodule-internal staged row is read-only from the parent worktree, so don't offer Unstage (mirrors bulk unstage).
  const canUnstage = canUnstageStatusEntry(entry)

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      relativePath={entry.path}
      connectionId={connectionId}
      onView={() => onOpen(entry)}
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
        // Why: open file gets the strongest accent, outranking the bulk-selection tint so it always reads as active.
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
          if (submoduleExpansion) {
            // Why: a double-click emits two click events; without this guard it expands then immediately collapses.
            if (e.detail > 1) {
              return
            }
            submoduleExpansion.onToggle()
            return
          }
          if (onSelect) {
            onSelect(e, entryKey, entry)
          } else {
            onOpen(entry, e)
          }
        }}
        onDoubleClick={(e) => {
          if (submoduleExpansion) {
            return
          }
          onOpen(entry, toPermanentSourceControlRowOpenEvent(e))
        }}
      >
        {submoduleExpansion && (
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              !submoduleExpansion.isExpanded && '-rotate-90'
            )}
          />
        )}
        <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <div className="min-w-0 flex-1 text-xs">
          <span className="min-w-0 block truncate">
            <span className="text-foreground">{fileName}</span>
            {showPathHint && dirPath && (
              <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
            )}
          </span>
          {conflictLabel && (
            <div className="truncate text-[11px] text-muted-foreground">{conflictLabel}</div>
          )}
          {isSubmoduleWorktreeOnly && (
            // Why: parent git stages the changed gitlink but not nested worktree dirtiness; keep that boundary visible.
            <div
              className="truncate text-[11px] text-muted-foreground"
              title={SUBMODULE_WORKTREE_ONLY_TOOLTIP}
            >
              {SUBMODULE_WORKTREE_ONLY_LABEL}
            </div>
          )}
        </div>
        {commentCount > 0 && (
          // Why: surface a per-row marker so files with review notes are visible without opening the Notes tab.
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
          {canStage && (
            <ActionButton
              icon={Plus}
              title={translate('auto.components.right.sidebar.SourceControl.8cde1a2fb0', 'Stage')}
              onClick={(event) => {
                event.stopPropagation()
                void onStage(entry.path)
              }}
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
