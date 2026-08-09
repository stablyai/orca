import type React from 'react'
import { ArrowUpRight, History, RefreshCw } from 'lucide-react'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'
import {
  toPermanentSourceControlRowOpenEvent,
  toSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { formatGitHistoryTimestamp } from './git-history-format'
import type { GitBranchChangeEntry, GitFileStatus } from '../../../../shared/types'

// State for a single commit's lazily-loaded file list. Owned by GitHistoryPanel,
// populated through the onLoadCommitFiles loader supplied by SourceControl.
export type GitHistoryCommitFilesState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: GitBranchChangeEntry[] }

function CommitFileRow({
  entry,
  onOpen,
  onHistory
}: {
  entry: GitBranchChangeEntry
  onOpen: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onHistory?: (entry: GitBranchChangeEntry) => void
}): React.JSX.Element {
  const status = entry.status as GitFileStatus
  const FileIcon = getFileTypeIcon(entry.path)
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <div
      className="group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pl-9 pr-3 text-left text-xs transition-colors hover:bg-accent/40"
      title={entry.path}
      role="button"
      tabIndex={0}
      data-testid="git-history-commit-file"
      onClick={(event) => onOpen(entry, toSourceControlRowOpenEvent(event))}
      onDoubleClick={(event) => onOpen(entry, toPermanentSourceControlRowOpenEvent(event))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(entry, toSourceControlRowOpenEvent(event))
        }
      }}
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
      {onHistory && (
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus-visible:text-foreground can-hover:opacity-0 can-hover:group-hover:opacity-100"
          title={translate(
            'auto.components.right.sidebar.GitHistoryCommitFiles.1f2a3b4c5d',
            'Show file history'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.GitHistoryCommitFiles.1f2a3b4c5d',
            'Show file history'
          )}
          onClick={(event) => {
            event.stopPropagation()
            onHistory(entry)
          }}
        >
          <History className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function CommitFilesBody({
  state,
  onOpenFile,
  onHistory,
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onHistory?: (entry: GitBranchChangeEntry) => void
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
      {state.entries.map((entry) => (
        <CommitFileRow
          key={entry.path}
          entry={entry}
          onOpen={onOpenFile}
          onHistory={onHistory}
        />
      ))}
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

export function GitHistoryCommitFiles({
  state,
  author,
  timestamp,
  onOpenFile,
  onHistory,
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  author?: string
  timestamp?: number
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onHistory?: (entry: GitBranchChangeEntry) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  // Author and date move off the dense commit row and surface here on expand.
  const meta = [author, formatGitHistoryTimestamp(timestamp)].filter(Boolean).join(' · ')
  return (
    <div className="border-l border-border/60 bg-muted/20">
      {meta && <div className="py-1 pl-9 pr-3 text-[11px] text-muted-foreground">{meta}</div>}
      <CommitFilesBody
        state={state}
        onOpenFile={onOpenFile}
        onHistory={onHistory}
        onOpenAll={onOpenAll}
      />
    </div>
  )
}
