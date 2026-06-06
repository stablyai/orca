import React, { useMemo } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'

function statusLabel(entry: PendingWorktreeCreation): string {
  if (entry.status === 'error') {
    return entry.error ?? 'Creation failed'
  }
  return entry.phase === 'creating' ? 'Creating worktree…' : 'Fetching base branch…'
}

function PendingRow({
  entry,
  active
}: {
  entry: PendingWorktreeCreation
  active: boolean
}): React.JSX.Element {
  const isError = entry.status === 'error'
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 rounded-md transition-colors',
        active
          ? 'border border-sidebar-ring/35 bg-sidebar-accent/70 ring-1 ring-sidebar-ring/30'
          : 'border border-transparent hover:bg-sidebar-accent/60'
      )}
    >
      <button
        type="button"
        // Why: never route this through setActiveWorktree — there is no real
        // worktree yet. activePendingCreationId drives the content panel instead.
        onClick={() => {
          const store = useAppStore.getState()
          store.setActivePendingWorktreeCreation(entry.creationId)
          store.setActiveView('terminal')
        }}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {isError ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-sidebar-foreground">
            {entry.request.displayName || entry.request.name}
          </span>
          <span
            className={cn(
              'block truncate text-[11px]',
              isError ? 'text-destructive/90' : 'text-muted-foreground'
            )}
          >
            {statusLabel(entry)}
          </span>
        </span>
      </button>
      <button
        type="button"
        title="Cancel"
        aria-label="Cancel worktree creation"
        onClick={() => useAppStore.getState().removePendingWorktreeCreation(entry.creationId)}
        className={cn(
          'mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100',
          isError ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export default function PendingWorktreeCreationsStrip(): React.JSX.Element | null {
  // Why: subscribe to the map reference (not Object.values) so this selector
  // doesn't allocate a fresh array on every unrelated store update — e.g. PTY
  // streaming during creation. The ref only changes when an entry is added,
  // updated, or removed, so memoizing the values keeps re-renders minimal.
  const pendingMap = useAppStore((s) => s.pendingWorktreeCreations)
  const activePendingCreationId = useAppStore((s) => s.activePendingCreationId)
  const pending = useMemo(() => Object.values(pendingMap), [pendingMap])

  if (pending.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5">
      {pending.map((entry) => (
        <PendingRow
          key={entry.creationId}
          entry={entry}
          active={entry.creationId === activePendingCreationId}
        />
      ))}
    </div>
  )
}
