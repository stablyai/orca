import type React from 'react'
import { ArrowUpRight, ChevronDown, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import type {
  GitBranchChangeEntry,
  GitFileStatus,
  SourceControlViewMode
} from '../../../../shared/types'
import { formatGitHistoryTimestamp } from './git-history-format'
import {
  toPermanentSourceControlRowOpenEvent,
  toSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import {
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  namespaceSourceControlTreeDirectoryKeys,
  SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX,
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX,
  type SourceControlTreeDirectoryNode
} from './source-control-tree'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'

// State for a single commit's lazily-loaded file list. Owned by GitHistoryPanel,
// populated through the onLoadCommitFiles loader supplied by SourceControl.
export type GitHistoryCommitFilesState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: GitBranchChangeEntry[] }

export type GitHistoryCommitFilesRow =
  | { kind: 'meta'; commitId: string; text: string }
  | { kind: 'loading'; commitId: string }
  | { kind: 'error'; commitId: string; error: string }
  | { kind: 'empty'; commitId: string }
  | {
      kind: 'file'
      commitId: string
      entry: GitBranchChangeEntry
      depth?: number
      showPathHint: boolean
    }
  | {
      kind: 'directory'
      commitId: string
      node: SourceControlTreeDirectoryNode<GitBranchChangeEntry, 'commit'>
      isCollapsed: boolean
    }
  | { kind: 'open-all'; commitId: string }

export function buildGitHistoryCommitFilesRows({
  commitId,
  viewMode,
  state,
  author,
  timestamp,
  collapsedTreeDirs,
  canOpenAll
}: {
  commitId: string
  viewMode: SourceControlViewMode
  state: GitHistoryCommitFilesState
  author?: string
  timestamp?: number
  collapsedTreeDirs: ReadonlySet<string>
  canOpenAll: boolean
}): GitHistoryCommitFilesRow[] {
  const rows: GitHistoryCommitFilesRow[] = []
  const meta = [author, formatGitHistoryTimestamp(timestamp)].filter(Boolean).join(' · ')
  if (meta) {
    rows.push({ kind: 'meta', commitId, text: meta })
  }

  if (state.status === 'loading') {
    rows.push({ kind: 'loading', commitId })
    return rows
  }
  if (state.status === 'error') {
    rows.push({ kind: 'error', commitId, error: state.error })
    return rows
  }
  if (state.entries.length === 0) {
    rows.push({ kind: 'empty', commitId })
    return rows
  }

  if (viewMode === 'list') {
    for (const entry of state.entries) {
      rows.push({ kind: 'file', commitId, entry, showPathHint: true })
    }
  } else {
    const compactedTree = compactSourceControlTree(buildSourceControlTree('commit', state.entries))
    // Why: identical paths in separate commits need independent collapse state.
    const treeRoots = namespaceSourceControlTreeDirectoryKeys(compactedTree, `commit:${commitId}`)
    const treeRows = flattenSourceControlTree(treeRoots, collapsedTreeDirs)
    for (const node of treeRows) {
      if (node.type === 'directory') {
        rows.push({
          kind: 'directory',
          commitId,
          node,
          isCollapsed: collapsedTreeDirs.has(node.key)
        })
      } else {
        rows.push({
          kind: 'file',
          commitId,
          entry: node.entry,
          depth: node.depth,
          showPathHint: false
        })
      }
    }
  }

  if (canOpenAll) {
    rows.push({ kind: 'open-all', commitId })
  }
  return rows
}

export function getGitHistoryCommitFilesRowKey(row: GitHistoryCommitFilesRow): string {
  let identity: string
  switch (row.kind) {
    case 'file':
      identity = row.entry.path
      break
    case 'directory':
      identity = row.node.key
      break
    case 'meta':
    case 'loading':
    case 'error':
    case 'empty':
    case 'open-all':
      identity = row.kind
      break
  }
  return `commit-files:${row.commitId}:${row.kind}:${identity}`
}

const DETAIL_ROW_CLASS = 'border-l border-border/60 bg-muted/20'

function CommitFileRow({
  commitId,
  entry,
  onOpen,
  depth,
  showPathHint
}: {
  commitId: string
  entry: GitBranchChangeEntry
  onOpen: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  depth?: number
  showPathHint: boolean
}): React.JSX.Element {
  const status = entry.status as GitFileStatus
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isTreeRow = depth !== undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            DETAIL_ROW_CLASS,
            'group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pr-3 text-left text-xs transition-colors hover:bg-accent/40',
            !isTreeRow && 'pl-9'
          )}
          style={
            isTreeRow
              ? {
                  paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
                }
              : undefined
          }
          data-testid="git-history-commit-file"
          data-commit-id={commitId}
          data-history-commit-detail=""
          data-file-path={entry.path}
          onClick={(event) => onOpen(entry, toSourceControlRowOpenEvent(event))}
          onDoubleClick={(event) => onOpen(entry, toPermanentSourceControlRowOpenEvent(event))}
        >
          <FileIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[status] }} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-foreground">{fileName}</span>
            {showPathHint && dirPath && (
              <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>
            )}
          </span>
          <span
            className="w-4 shrink-0 text-center text-[10px] font-bold"
            style={{ color: STATUS_COLORS[status] }}
          >
            {STATUS_LABELS[status]}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6} className="max-w-sm break-all font-mono text-xs">
        {entry.path}
      </TooltipContent>
    </Tooltip>
  )
}

function CommitTreeDirectoryRow({
  commitId,
  node,
  isCollapsed,
  onToggle
}: {
  commitId: string
  node: SourceControlTreeDirectoryNode<GitBranchChangeEntry, 'commit'>
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            DETAIL_ROW_CLASS,
            'group relative flex w-full items-center gap-1 py-1 pr-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground'
          )}
          style={{
            paddingLeft: `${node.depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX}px`
          }}
          data-testid="git-history-commit-directory"
          data-commit-id={commitId}
          data-history-commit-detail=""
          data-tree-path={node.path}
          onClick={onToggle}
          aria-expanded={!isCollapsed}
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform motion-reduce:transition-none',
              isCollapsed && '-rotate-90'
            )}
          />
          {isCollapsed ? (
            <Folder className="size-3 shrink-0" />
          ) : (
            <FolderOpen className="size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="w-4 shrink-0 text-center text-[10px] font-bold tabular-nums text-muted-foreground/80">
            {node.fileCount}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6} className="max-w-sm break-all font-mono text-xs">
        {node.path}
      </TooltipContent>
    </Tooltip>
  )
}

export function GitHistoryCommitFilesRowView({
  row,
  onToggleTreeDirectory,
  onOpenFile,
  onOpenAll
}: {
  row: GitHistoryCommitFilesRow
  onToggleTreeDirectory: (key: string) => void
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  switch (row.kind) {
    case 'meta':
      return (
        <div
          className={cn(DETAIL_ROW_CLASS, 'py-1 pl-9 pr-3 text-[11px] text-muted-foreground')}
          data-commit-id={row.commitId}
          data-history-commit-detail=""
        >
          {row.text}
        </div>
      )
    case 'loading':
      return (
        <div
          className={cn(
            DETAIL_ROW_CLASS,
            'flex items-center gap-2 py-1 pl-9 pr-3 text-[11px] text-muted-foreground'
          )}
          data-commit-id={row.commitId}
          data-history-commit-detail=""
        >
          <RefreshCw className="size-3 animate-spin" />
          <span>
            {translate(
              'auto.components.right.sidebar.GitHistoryCommitFiles.a1b2c3d4e5',
              'Loading files…'
            )}
          </span>
        </div>
      )
    case 'error':
      return (
        <div
          className={cn(DETAIL_ROW_CLASS, 'py-1 pl-9 pr-3 text-[11px] text-destructive')}
          data-commit-id={row.commitId}
          data-history-commit-detail=""
          title={row.error}
        >
          {row.error}
        </div>
      )
    case 'empty':
      return (
        <div
          className={cn(DETAIL_ROW_CLASS, 'py-1 pl-9 pr-3 text-[11px] text-muted-foreground')}
          data-commit-id={row.commitId}
          data-history-commit-detail=""
        >
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFiles.b2c3d4e5f6',
            'No file changes in this commit'
          )}
        </div>
      )
    case 'file':
      return (
        <CommitFileRow
          commitId={row.commitId}
          entry={row.entry}
          depth={row.depth}
          showPathHint={row.showPathHint}
          onOpen={onOpenFile}
        />
      )
    case 'directory':
      return (
        <CommitTreeDirectoryRow
          commitId={row.commitId}
          node={row.node}
          isCollapsed={row.isCollapsed}
          onToggle={() => onToggleTreeDirectory(row.node.key)}
        />
      )
    case 'open-all':
      return (
        <button
          type="button"
          className={cn(
            DETAIL_ROW_CLASS,
            'flex w-full items-center gap-1 py-1 pl-9 pr-3 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground'
          )}
          data-commit-id={row.commitId}
          data-history-commit-detail=""
          onClick={onOpenAll}
        >
          <ArrowUpRight className="size-3 shrink-0" />
          <span>
            {translate(
              'auto.components.right.sidebar.GitHistoryCommitFiles.c3d4e5f6a7',
              'Open all changes together'
            )}
          </span>
        </button>
      )
  }
}
