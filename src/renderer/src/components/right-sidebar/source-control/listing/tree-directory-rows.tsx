import React from 'react'
import { ChevronDown, Folder, FolderOpen, Minus, Plus, Trash, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DiscardAllArea } from '../commit/discard-all-sequence'
import type {
  BranchSourceControlTreeDirectoryNode,
  SourceControlDirectoryActionPaths,
  SourceControlTreeDirectoryNode
} from './directory-action-paths'
import { ActionButton } from './action-button'
import {
  SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS,
  SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX
} from './row-layout'

/** Shared chrome for both directory rows: indentation, collapse toggle, folder icon, name, file count. */
function SourceControlTreeDirectoryHeader({
  node,
  isCollapsed,
  onToggle,
  children
}: {
  node: Pick<SourceControlTreeDirectoryNode, 'depth' | 'name' | 'fileCount'>
  isCollapsed: boolean
  onToggle: () => void
  children?: React.ReactNode
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
      {children}
    </div>
  )
}

/**
 * Working-tree directory row. `actionPaths` must already be scoped to the currently visible
 * descendants, and bulk actions only render when that scope is non-empty.
 */
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
  node: SourceControlTreeDirectoryNode
  actionPaths: SourceControlDirectoryActionPaths
  hideBulkActions: boolean
  isExecutingBulk: boolean
  isCollapsed: boolean
  onToggle: () => void
  onRequestDiscardPaths: (area: DiscardAllArea, paths: readonly string[]) => void
  onStagePaths: (paths: readonly string[]) => Promise<void>
  onUnstagePaths: (paths: readonly string[]) => Promise<void>
}): React.JSX.Element {
  // Why: filtered tree nodes only contain visible descendants, so folder-wide bulk labels would overpromise on the subset.
  const canStage = !hideBulkActions && actionPaths.stagePaths.length > 0
  const canUnstage = !hideBulkActions && actionPaths.unstagePaths.length > 0
  const canDiscard = !hideBulkActions && actionPaths.discardPaths.length > 0

  return (
    <SourceControlTreeDirectoryHeader node={node} isCollapsed={isCollapsed} onToggle={onToggle}>
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
    </SourceControlTreeDirectoryHeader>
  )
}

/** Branch-compare directory row: read-only, so it deliberately exposes no stage/discard actions. */
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
    <SourceControlTreeDirectoryHeader node={node} isCollapsed={isCollapsed} onToggle={onToggle} />
  )
}
