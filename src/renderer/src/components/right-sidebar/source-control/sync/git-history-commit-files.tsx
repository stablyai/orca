import type React from 'react'
import { useMemo, useState } from 'react'
import { ArrowUpRight, ChevronDown, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'
import {
  toPermanentSourceControlRowOpenEvent,
  toSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from '../listing/split-open'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatGitHistoryTimestamp } from './git-history-format'
import { flattenSourceControlTree } from '../../source-control-tree'
import { SOURCE_CONTROL_TREE_INDENT_PX } from '../listing/row-layout'
import {
  buildGitHistoryCommitFileTree,
  type GitHistoryCommitTreeNode
} from './git-history-commit-file-tree'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitFileStatus } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'

// Why: matches the `pl-9` the flat list uses so tree rows keep nesting under the commit row.
const COMMIT_FILE_BASE_PADDING_PX = 36

// State for a single commit's lazily-loaded file list. Owned by GitHistoryPanel,
// populated through the onLoadCommitFiles loader supplied by SourceControl.
export type GitHistoryCommitFilesState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: GitBranchChangeEntry[] }

/**
 * One changed file inside an expanded commit. `depth` switches the row from the
 * flat list's fixed indent to tree indentation; `showPathHint` hides the dimmed
 * directory suffix that the surrounding tree already expresses.
 */
function CommitFileRow({
  entry,
  onOpen,
  depth,
  showPathHint = true
}: {
  entry: GitBranchChangeEntry
  onOpen: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  depth?: number
  showPathHint?: boolean
}): React.JSX.Element {
  const status = entry.status as GitFileStatus
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pr-3 text-left text-xs transition-colors hover:bg-accent/40',
        depth === undefined && 'pl-9'
      )}
      style={
        depth === undefined
          ? undefined
          : {
              paddingLeft: `${COMMIT_FILE_BASE_PADDING_PX + depth * SOURCE_CONTROL_TREE_INDENT_PX}px`
            }
      }
      title={entry.path}
      data-testid="git-history-commit-file"
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
  )
}

/**
 * One directory level inside an expanded commit's tree, showing how many changed
 * files it contains and toggling its subtree open or closed.
 */
function CommitDirectoryRow({
  name,
  depth,
  fileCount,
  isCollapsed,
  onToggle
}: {
  name: string
  depth: number
  fileCount: number
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div
      className="group flex w-full items-center gap-1 py-1 pr-3 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      style={{
        paddingLeft: `${COMMIT_FILE_BASE_PADDING_PX + depth * SOURCE_CONTROL_TREE_INDENT_PX}px`
      }}
      data-testid="git-history-commit-directory"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
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

// Why: collapse state is per mounted commit, so directory keys never collide across
// commits and the tree needs no key namespacing.
/**
 * Tree view of a commit's changed files. Collapse state is per instance, and this
 * component mounts only while its commit is expanded, so two expanded commits can
 * never share directory keys.
 */
function CommitFileTree({
  entries,
  compactFolders,
  onOpenFile
}: {
  entries: GitBranchChangeEntry[]
  compactFolders: boolean
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
}): React.JSX.Element {
  const [collapsedDirectoryKeys, setCollapsedDirectoryKeys] = useState<Set<string>>(() => new Set())
  const roots = useMemo(
    () => buildGitHistoryCommitFileTree(entries, compactFolders),
    [entries, compactFolders]
  )
  const rows = useMemo(
    () => flattenSourceControlTree(roots, collapsedDirectoryKeys),
    [roots, collapsedDirectoryKeys]
  )

  /** Opens a collapsed directory or collapses an open one. */
  const toggleDirectory = (key: string): void => {
    setCollapsedDirectoryKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <>
      {rows.map((node: GitHistoryCommitTreeNode) =>
        node.type === 'directory' ? (
          <CommitDirectoryRow
            key={node.key}
            name={node.name}
            depth={node.depth}
            fileCount={node.fileCount}
            isCollapsed={collapsedDirectoryKeys.has(node.key)}
            onToggle={() => toggleDirectory(node.key)}
          />
        ) : (
          <CommitFileRow
            key={node.key}
            entry={node.entry}
            depth={node.depth}
            showPathHint={false}
            onOpen={onOpenFile}
          />
        )
      )}
    </>
  )
}

/**
 * Renders the body of an expanded commit: the loading, error, and empty states, then
 * either the tree or the flat list depending on the Source Control view mode.
 */
function CommitFilesBody({
  state,
  viewMode,
  compactFolders,
  onOpenFile,
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  viewMode: SourceControlViewMode
  compactFolders: boolean
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-1 pl-9 pr-3 text-[11px] text-muted-foreground">
        <RefreshCw className="size-3 animate-spin" />
        <span>
          {translate(
            'auto.components.right.sidebar.GitHistoryCommitFiles.a1b2c3d4e5',
            'Loading files…'
          )}
        </span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="py-1 pl-9 pr-3 text-[11px] text-destructive" title={state.error}>
        {state.error}
      </div>
    )
  }

  if (state.entries.length === 0) {
    return (
      <div className="py-1 pl-9 pr-3 text-[11px] text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.GitHistoryCommitFiles.b2c3d4e5f6',
          'No file changes in this commit'
        )}
      </div>
    )
  }

  return (
    <>
      {viewMode === 'tree' ? (
        <CommitFileTree
          entries={state.entries}
          compactFolders={compactFolders}
          onOpenFile={onOpenFile}
        />
      ) : (
        state.entries.map((entry) => (
          <CommitFileRow key={entry.path} entry={entry} onOpen={onOpenFile} />
        ))
      )}
      {onOpenAll && (
        <button
          type="button"
          className="flex w-full items-center gap-1 py-1 pl-9 pr-3 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
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
      )}
    </>
  )
}

/**
 * The panel shown under an expanded commit row: author and date, the changed files,
 * and the optional "open all changes" action.
 */
export function GitHistoryCommitFiles({
  state,
  viewMode,
  compactFolders,
  author,
  timestamp,
  onOpenFile,
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  viewMode: SourceControlViewMode
  compactFolders: boolean
  author?: string
  timestamp?: number
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  // Author and date move off the dense commit row and surface here on expand.
  const meta = [author, formatGitHistoryTimestamp(timestamp)].filter(Boolean).join(' · ')
  return (
    <div className="border-l border-border/60 bg-muted/20">
      {meta && <div className="py-1 pl-9 pr-3 text-[11px] text-muted-foreground">{meta}</div>}
      <CommitFilesBody
        state={state}
        viewMode={viewMode}
        compactFolders={compactFolders}
        onOpenFile={onOpenFile}
        onOpenAll={onOpenAll}
      />
    </div>
  )
}
