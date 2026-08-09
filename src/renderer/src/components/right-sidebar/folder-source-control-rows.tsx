import React from 'react'
import { AlertTriangle, ChevronDown, GitBranch, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import type { GitStatusResult } from '../../../../shared/types'
import type { FolderGitTarget } from './folder-source-control-repos'

export type RepoStatusState = {
  status: GitStatusResult | null
  error: string | null
  loading: boolean
}

function getRepoLabel(parentPath: string, target: FolderGitTarget): string {
  const relativePath = relativePathInsideRoot(parentPath, target.path)
  return relativePath || target.displayName
}

export function FolderRepoRow({
  target,
  parentPath,
  statusState,
  isExpanded,
  onToggleExpanded
}: {
  target: FolderGitTarget
  parentPath: string
  statusState: RepoStatusState | undefined
  isExpanded: boolean
  onToggleExpanded: () => void
}): React.JSX.Element {
  const count = statusState?.status?.statusLength ?? statusState?.status?.entries.length ?? 0

  return (
    <div className="group flex min-w-0 items-center gap-1 py-1 pr-3 pl-2 text-xs">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={onToggleExpanded}
        aria-expanded={isExpanded}
      >
        <ChevronDown
          className={cn('size-3 shrink-0 transition-transform', !isExpanded && '-rotate-90')}
        />
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {getRepoLabel(parentPath, target)}
        </span>
      </button>
      {statusState?.loading ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {!statusState?.loading && statusState?.error ? (
        <AlertTriangle
          className="size-3 shrink-0 text-destructive"
          aria-label={statusState.error}
        />
      ) : null}
      {!statusState?.loading && count > 0 ? (
        <span className="shrink-0 text-[10px] font-bold tabular-nums text-muted-foreground/80">
          {count}
        </span>
      ) : null}
    </div>
  )
}
