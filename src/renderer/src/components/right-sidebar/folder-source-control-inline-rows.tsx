import React from 'react'
import { ChevronDown, Folder, FolderOpen, Minus, Plus, Trash, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { basename, dirname } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../shared/types'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'

export const SECTION_LABELS: Record<
  'staged' | 'unstaged' | 'untracked',
  { key: string; fallback: string }
> = {
  staged: {
    key: 'auto.components.right.sidebar.SourceControl.48a003c1b1',
    fallback: 'Staged Changes'
  },
  unstaged: {
    key: 'auto.components.right.sidebar.SourceControl.d4ef4bafc5',
    fallback: 'Changes'
  },
  untracked: {
    key: 'auto.components.right.sidebar.SourceControl.522f44dce5',
    fallback: 'Untracked Files'
  }
}

/** Groups status entries into staged, unstaged, and untracked buckets. */
export function groupStatusEntries(
  entries: readonly GitStatusEntry[]
): Record<'staged' | 'unstaged' | 'untracked', GitStatusEntry[]> {
  const groups: Record<'staged' | 'unstaged' | 'untracked', GitStatusEntry[]> = {
    staged: [],
    unstaged: [],
    untracked: []
  }
  for (const entry of entries) {
    groups[entry.area].push(entry)
  }
  return groups
}

/** Renders one source-control file row with optional inline actions. */
export function InlineFileRow({
  path,
  status,
  added,
  removed,
  onOpen,
  depth = 0,
  canStage = false,
  canUnstage = false,
  canDiscard = false,
  onStage,
  onUnstage,
  onDiscard
}: {
  path: string
  status: GitStatusEntry['status']
  added?: number
  removed?: number
  onOpen: () => void
  depth?: number
  canStage?: boolean
  canUnstage?: boolean
  canDiscard?: boolean
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(path)
  const fileName = basename(path)
  const parentDir = dirname(path)
  const dirPath = parentDir === '.' ? '' : parentDir
  return (
    <div
      className="group flex min-w-0 cursor-pointer items-center gap-1 py-1 pr-3 text-xs hover:bg-accent/40"
      style={{ paddingLeft: `${depth * 14 + 12}px` }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      data-source-control-path={path}
    >
      <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[status] }} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{fileName}</span>
        {dirPath ? (
          <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
        ) : null}
      </span>
      {typeof added === 'number' && added > 0 ? (
        <span
          className="shrink-0 text-[10px] tabular-nums"
          style={{ color: 'var(--git-decoration-added)' }}
        >
          +{added}
        </span>
      ) : null}
      {typeof removed === 'number' && removed > 0 ? (
        <span
          className="shrink-0 text-[10px] tabular-nums"
          style={{ color: 'var(--git-decoration-deleted)' }}
        >
          -{removed}
        </span>
      ) : null}
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[status] }}
      >
        {STATUS_LABELS[status]}
      </span>
      {(canStage || canUnstage || canDiscard) && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {canDiscard ? (
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={
                status === 'untracked'
                  ? translate(
                      'auto.components.right.sidebar.SourceControl.11463f7a98',
                      'Delete file'
                    )
                  : translate(
                      'auto.components.right.sidebar.SourceControl.d54dd48b0b',
                      'Discard changes'
                    )
              }
              onClick={(event) => {
                event.stopPropagation()
                onDiscard?.()
              }}
            >
              {status === 'untracked' ? <Trash className="size-3" /> : <Undo2 className="size-3" />}
            </button>
          ) : null}
          {canStage ? (
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={translate('auto.components.right.sidebar.SourceControl.8cde1a2fb0', 'Stage')}
              onClick={(event) => {
                event.stopPropagation()
                onStage?.()
              }}
            >
              <Plus className="size-3" />
            </button>
          ) : null}
          {canUnstage ? (
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={translate('auto.components.right.sidebar.SourceControl.df5040e3c3', 'Unstage')}
              onClick={(event) => {
                event.stopPropagation()
                onUnstage?.()
              }}
            >
              <Minus className="size-3" />
            </button>
          ) : null}
        </span>
      )}
    </div>
  )
}

/** Renders a collapsible directory row for tree-mode source control. */
export function InlineTreeDirectoryRow({
  name,
  fileCount,
  depth,
  isCollapsed,
  onToggle
}: {
  name: string
  fileCount: number
  depth: number
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div
      className="group flex min-w-0 items-center gap-1 py-1 pr-3 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      style={{ paddingLeft: `${depth * 14 + 12}px` }}
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
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      <span className="w-4 shrink-0 text-center text-[10px] font-bold tabular-nums text-muted-foreground/80">
        {fileCount}
      </span>
    </div>
  )
}

/** Renders a source-control section header with bulk action slots. */
export function InlineSectionHeader({
  label,
  count,
  isCollapsed,
  onToggle,
  actions,
  hoverActions
}: {
  label: string
  count: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
  hoverActions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group flex min-w-0 items-center gap-1 py-1 pr-3 pl-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider text-foreground/70"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
      >
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
        />
        <span className="truncate">{label}</span>
        <span className="text-[10px] font-medium tabular-nums">{count}</span>
      </button>
      {actions ? <span className="flex shrink-0 items-center">{actions}</span> : null}
      {hoverActions ? (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {hoverActions}
        </span>
      ) : null}
    </div>
  )
}

/** Returns the localized label for a source-control section. */
export function sectionLabel(area: 'staged' | 'unstaged' | 'untracked'): string {
  const label = SECTION_LABELS[area]
  return translate(label.key, label.fallback)
}
