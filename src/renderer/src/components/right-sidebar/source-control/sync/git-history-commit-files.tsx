import { createElement } from 'react'
import type React from 'react'
import { ArrowUpRight } from 'lucide-react'
import { STATUS_COLORS } from '../../../../lib/git-path-decoration'
import { STATUS_LABELS } from '../../../../../../shared/git/status/git-status-labels'
import {
  toPermanentSourceControlRowOpenEvent,
  toSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from '../listing/split-open'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { basename, dirname } from '@/lib/path'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatGitHistoryTimestamp } from './git-history-format'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitFileStatus } from '../../../../../../shared/git/status/git-status-types'

export type GitHistoryCommitFilesState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; entries: GitBranchChangeEntry[] }

function CommitFileRow({
  entry,
  onOpen
}: {
  entry: GitBranchChangeEntry
  onOpen: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
}): React.JSX.Element {
  const status = entry.status as GitFileStatus
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <button
      type="button"
      className="group flex w-full min-w-0 cursor-pointer items-center gap-1 py-1 pl-9 pr-3 text-left text-xs transition-colors hover:bg-accent/40"
      title={entry.path}
      data-testid="git-history-commit-file"
      onClick={(event) => onOpen(entry, toSourceControlRowOpenEvent(event))}
      onDoubleClick={(event) => onOpen(entry, toPermanentSourceControlRowOpenEvent(event))}
    >
      {createElement(FileTypeIcon, {
        filePath: entry.path,
        className: 'size-3.5 shrink-0',
        style: { color: STATUS_COLORS[status] }
      })}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-left text-foreground" dir="rtl">
          <bdi>{fileName}</bdi>
        </span>
        {dirPath && (
          <span
            className="min-w-0 flex-1 truncate text-left text-2xs text-muted-foreground"
            dir="rtl"
          >
            <bdi>{dirPath}</bdi>
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-2xs text-[color:var(--git-decoration-added)]">
        {entry.added !== undefined ? `+${entry.added}` : ''}
      </span>
      <span className="shrink-0 font-mono text-2xs text-[color:var(--git-decoration-deleted)]">
        {entry.removed !== undefined ? `−${entry.removed}` : ''}
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

function CommitFilesBody({
  state,
  onOpenFile,
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state.status === 'loading') {
    return <div className="h-6" />
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
        {t(
          'auto.components.right.sidebar.GitHistoryCommitFiles.b2c3d4e5f6',
          'No file changes in this commit'
        )}
      </div>
    )
  }

  return (
    <>
      {state.entries.map((entry) => (
        <CommitFileRow key={entry.path} entry={entry} onOpen={onOpenFile} />
      ))}
      {onOpenAll && (
        <button
          type="button"
          className="flex w-full items-center gap-1 py-1 pl-9 pr-3 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          onClick={onOpenAll}
        >
          <ArrowUpRight className="size-3 shrink-0" />
          <span>
            {t(
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
  onOpenAll
}: {
  state: GitHistoryCommitFilesState
  author?: string
  timestamp?: number
  onOpenFile: (entry: GitBranchChangeEntry, event: SourceControlRowOpenEvent) => void
  onOpenAll?: () => void
}): React.JSX.Element {
  const intlLocale = useIntlLocale()
  const meta = [author, formatGitHistoryTimestamp(timestamp, intlLocale)]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="border-l border-border/60 bg-muted/20">
      {meta && <div className="py-1 pl-9 pr-3 text-[11px] text-muted-foreground">{meta}</div>}
      <CommitFilesBody state={state} onOpenFile={onOpenFile} onOpenAll={onOpenAll} />
    </div>
  )
}
