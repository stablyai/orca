import { createElement, useState } from 'react'
import { Check, ChevronDown, FolderGit2, GitBranch, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename, dirname } from '@/lib/path'
import { cn } from '@/lib/utils'
import type { GitStatusEntry, GitStatusResult } from '../../../../../../shared/git-status-types'
import { STATUS_COLORS, STATUS_LABELS } from '../../status-display'
import type { FolderSourceControlRepository } from './folder-repository-resolution'

export type FolderRepositoryStatus =
  | { state: 'loading' }
  | { state: 'ready'; status: GitStatusResult }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string }

const AREA_LABELS: Record<GitStatusEntry['area'], { key: string; fallback: string }> = {
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

function ChangedFileRow({
  entry,
  onOpen
}: {
  entry: GitStatusEntry
  onOpen: (openAsPermanent: boolean) => void
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(entry.path)
  const parent = dirname(entry.path)
  return (
    <button
      type="button"
      className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left text-xs transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      title={entry.path}
      onClick={(event) => {
        if (event.detail <= 1) {
          onOpen(false)
        }
      }}
      onDoubleClick={() => onOpen(true)}
    >
      {createElement(FileIcon, {
        className: 'size-3.5 shrink-0',
        style: { color: STATUS_COLORS[entry.status] }
      })}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {basename(entry.path)}
        {parent !== '.' && (
          <span className="ml-1.5 text-[11px] text-muted-foreground">{parent}</span>
        )}
      </span>
      <span
        className="w-4 shrink-0 text-center text-[10px] font-bold"
        style={{ color: STATUS_COLORS[entry.status] }}
      >
        {STATUS_LABELS[entry.status]}
      </span>
    </button>
  )
}

function RepositoryChanges({
  status,
  onOpen
}: {
  status: GitStatusResult
  onOpen: (entry: GitStatusEntry, openAsPermanent: boolean) => void
}): React.JSX.Element {
  if (status.entries.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-muted">
          <Check className="size-3" />
        </span>
        {translate(
          'auto.components.right.sidebar.folderSourceControl.clean',
          'No uncommitted changes'
        )}
      </div>
    )
  }

  return (
    <>
      {(['staged', 'unstaged', 'untracked'] as const).map((area) => {
        const entries = status.entries.filter((entry) => entry.area === area)
        if (entries.length === 0) {
          return null
        }
        return (
          <div key={area} className="pb-1 first:pt-1">
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-foreground/60">
              <span>{translate(AREA_LABELS[area].key, AREA_LABELS[area].fallback)}</span>
              <span className="tabular-nums text-muted-foreground">{entries.length}</span>
            </div>
            {entries.map((entry) => (
              <ChangedFileRow
                key={`${entry.area}:${entry.path}`}
                entry={entry}
                onOpen={(openAsPermanent) => onOpen(entry, openAsPermanent)}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

export function FolderRepositorySection({
  repository,
  result,
  onOpen
}: {
  repository: FolderSourceControlRepository
  result: FolderRepositoryStatus | undefined
  onOpen: (entry: GitStatusEntry, openAsPermanent: boolean) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const status = result?.state === 'ready' ? result.status : null
  const count = status?.entries.length
  const branch = (status?.branch ?? repository.worktree?.branch)?.replace(/^refs\/heads\//, '')

  return (
    <section className="mx-2 mt-2 overflow-hidden rounded-md border border-border bg-background last:mb-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-2 rounded-none px-2.5 py-2 text-left hover:bg-accent/60"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FolderGit2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-foreground">
            {repository.candidate.displayName}
          </span>
          {branch && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate font-mono">{branch}</span>
            </span>
          )}
        </span>
        {count !== undefined && (
          <Badge
            variant={count === 0 ? 'outline' : 'secondary'}
            className="h-5 min-w-5 px-1.5 text-[10px] font-medium tabular-nums"
          >
            {count}
          </Badge>
        )}
      </Button>

      {!collapsed && (
        <div className="border-t border-border/70 pb-1">
          {!result || result.state === 'loading' ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.right.sidebar.folderSourceControl.loadingStatus',
                'Loading changes…'
              )}
            </div>
          ) : result.state === 'ready' ? (
            <RepositoryChanges status={result.status} onOpen={onOpen} />
          ) : (
            <div className="px-3 py-3 text-xs text-muted-foreground">{result.message}</div>
          )}
        </div>
      )}
    </section>
  )
}
