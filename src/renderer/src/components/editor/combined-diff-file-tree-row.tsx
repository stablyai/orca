import type React from 'react'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { STATUS_COLORS, STATUS_LABELS } from '@/components/right-sidebar/status-display'
import type { SourceControlTreeNode } from '@/components/right-sidebar/source-control-tree'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import type {
  GitBranchChangeEntry,
  GitFileStatus,
  GitStagingArea,
  GitStatusEntry
} from '../../../../shared/types'
import {
  getCombinedDiffFileTreeSectionKey,
  type CombinedDiffBranchTreeArea,
  type CombinedDiffFileTreeEntry,
  type CombinedDiffFileTreeMode
} from './combined-diff-file-tree-model'

export type CombinedDiffTreeNode = SourceControlTreeNode<
  GitStatusEntry | GitBranchChangeEntry,
  GitStagingArea | CombinedDiffBranchTreeArea
>

const COMBINED_DIFF_TREE_INDENT_PX = 12
const COMBINED_DIFF_TREE_DIRECTORY_PADDING_PX = 8
const COMBINED_DIFF_TREE_FILE_PADDING_PX = 20

export function CombinedDiffFileTreeRow({
  node,
  mode,
  worktreePath,
  activeSectionKey,
  sectionIndexByKey,
  isCollapsed,
  onToggleDirectory,
  onNavigate
}: {
  node: CombinedDiffTreeNode
  mode: CombinedDiffFileTreeMode
  worktreePath: string
  activeSectionKey: string | null
  sectionIndexByKey: ReadonlyMap<string, number>
  isCollapsed: boolean
  onToggleDirectory: (key: string) => void
  onNavigate: (entry: CombinedDiffFileTreeEntry) => void
}): React.JSX.Element {
  if (node.type === 'directory') {
    return (
      <div
        className="group relative flex w-full items-center gap-1 py-1 pr-3 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        style={{
          paddingLeft: `${node.depth * COMBINED_DIFF_TREE_INDENT_PX + COMBINED_DIFF_TREE_DIRECTORY_PADDING_PX}px`
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, joinPath(worktreePath, node.path))
          event.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => onToggleDirectory(node.key)}
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

  const sectionKey = getCombinedDiffFileTreeSectionKey(mode, node.entry)
  const FileIcon = getFileTypeIcon(node.entry.path)
  const fileName = basename(node.entry.path)
  const parentDir = dirname(node.entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const status = node.entry.status as GitFileStatus
  const disabled = !sectionIndexByKey.has(sectionKey)

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pr-3 text-left text-xs transition-colors hover:bg-accent/40 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        activeSectionKey === sectionKey && 'bg-accent/60'
      )}
      style={{
        paddingLeft: `${node.depth * COMBINED_DIFF_TREE_INDENT_PX + COMBINED_DIFF_TREE_FILE_PADDING_PX}px`
      }}
      disabled={disabled}
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(
          WORKSPACE_FILE_PATH_MIME,
          joinPath(worktreePath, node.entry.path)
        )
        event.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => onNavigate(node.entry)}
    >
      <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[status] }} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{fileName}</span>
        {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[status] }}
      >
        {STATUS_LABELS[status]}
      </span>
    </button>
  )
}
