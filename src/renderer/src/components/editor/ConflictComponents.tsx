import React from 'react'
import { CircleCheck, GitMerge, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OpenFile } from '@/store/slices/editor'
import type { GitConflictKind, GitStatusEntry } from '../../../../shared/types'

export const CONFLICT_KIND_LABELS: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  both_deleted: 'Both deleted'
}

export const CONFLICT_HINT_MAP: Record<GitConflictKind, string> = {
  both_modified: 'Resolve the conflict markers',
  both_added: 'Choose which version to keep, or combine them',
  deleted_by_us: 'Decide whether to restore the file',
  deleted_by_them: 'Decide whether to keep the file or accept deletion',
  added_by_us: 'Review whether to keep the added file',
  added_by_them: 'Review the added file before keeping it',
  both_deleted: 'Resolve in Git or restore one side before editing'
}

export function ConflictBanner({
  file,
  entry
}: {
  file: OpenFile
  entry: GitStatusEntry | null
}): React.JSX.Element | null {
  const conflict = file.conflict
  if (!conflict) {
    return null
  }

  const isUnresolved = conflict.conflictStatus === 'unresolved'
  const label = isUnresolved ? 'Unresolved' : 'Resolved locally'

  return (
    <div
      className={cn(
        'border-b px-4 py-2 text-xs',
        isUnresolved
          ? 'border-destructive/20 bg-destructive/5'
          : 'border-emerald-500/20 bg-emerald-500/5'
      )}
    >
      <div className="flex items-center gap-2">
        {isUnresolved ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="font-medium text-foreground">
          {label} conflict · {CONFLICT_KIND_LABELS[conflict.conflictKind]}
        </span>
      </div>
      {/* Why: the hint is omitted here because the file is already open in the
         editor below. Showing "Open and edit…" or similar would be confusing
         when the user is already viewing/editing the working-tree contents.
         The hint is still shown in ConflictPlaceholderView and the review
         list where it provides actionable guidance. */}
      {!isUnresolved && (
        <div className="mt-1 text-muted-foreground">
          Session-local continuity state. Git is no longer reporting this file as unmerged.
        </div>
      )}
      {entry?.oldPath && (
        <div className="mt-1 text-muted-foreground">Renamed from {entry.oldPath}</div>
      )}
    </div>
  )
}

export function ConflictPlaceholderView({ file }: { file: OpenFile }): React.JSX.Element | null {
  const conflict = file.conflict
  if (!conflict) {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md space-y-2">
        <div className="text-sm font-medium text-foreground">
          {CONFLICT_KIND_LABELS[conflict.conflictKind]}
        </div>
        <div className="text-xs text-muted-foreground">
          {conflict.message ?? 'No working-tree file is available to edit for this conflict.'}
        </div>
        <div className="text-xs text-muted-foreground">
          {conflict.guidance ?? CONFLICT_HINT_MAP[conflict.conflictKind]}
        </div>
      </div>
    </div>
  )
}

export function ConflictReviewPanel({
  file,
  liveEntries,
  onOpenEntry,
  onDismiss,
  onRefreshSnapshot,
  onReturnToSourceControl
}: {
  file: OpenFile
  liveEntries: GitStatusEntry[]
  onOpenEntry: (entry: GitStatusEntry) => void
  onDismiss: () => void
  onRefreshSnapshot: () => void
  onReturnToSourceControl: () => void
}): React.JSX.Element {
  const snapshotEntries = file.conflictReview?.entries ?? []
  const liveEntriesByPath = new Map(liveEntries.map((entry) => [entry.path, entry]))
  const unresolvedSnapshotEntries = snapshotEntries.filter(
    (entry) => liveEntriesByPath.get(entry.path)?.conflictStatus === 'unresolved'
  )

  if (snapshotEntries.length > 0 && unresolvedSnapshotEntries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <div className="text-sm font-medium text-foreground">All conflicts resolved</div>
          <div className="text-xs text-muted-foreground">
            This review snapshot no longer has any live unresolved conflicts.
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onReturnToSourceControl}>
              <GitMerge className="size-3.5" />
              Source Control
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              <X className="size-3.5" />
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto px-4 py-4">
      <div className="mb-3">
        <div className="text-sm font-medium text-foreground">
          {snapshotEntries.length} unresolved conflict{snapshotEntries.length === 1 ? '' : 's'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Snapshot captured at{' '}
          {new Date(file.conflictReview?.snapshotTimestamp ?? Date.now()).toLocaleTimeString()}.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onRefreshSnapshot}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {snapshotEntries.map((snapshotEntry) => {
          const liveEntry = liveEntriesByPath.get(snapshotEntry.path)
          const isStillUnresolved = liveEntry?.conflictStatus === 'unresolved'
          return (
            <button
              key={snapshotEntry.path}
              type="button"
              className="flex w-full items-start justify-between rounded-md border border-border/60 px-3 py-2 text-left hover:bg-accent/30"
              onClick={() => {
                if (liveEntry) {
                  onOpenEntry(liveEntry)
                }
              }}
              disabled={!liveEntry}
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{snapshotEntry.path}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {CONFLICT_KIND_LABELS[snapshotEntry.conflictKind]} ·{' '}
                  {CONFLICT_HINT_MAP[snapshotEntry.conflictKind]}
                </div>
              </div>
              <span
                className={cn(
                  'ml-3 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  isStillUnresolved
                    ? 'bg-destructive/12 text-destructive'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {isStillUnresolved ? 'Unresolved' : liveEntry ? 'Resolved' : 'Gone'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
