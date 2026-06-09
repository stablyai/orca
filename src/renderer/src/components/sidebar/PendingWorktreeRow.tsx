import React from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  getCreationProgressLabel,
  type PendingWorktreeCreation
} from '@/lib/pending-worktree-creation'
import { translate } from '@/i18n/i18n'

function statusLabel(entry: PendingWorktreeCreation): string {
  if (entry.status === 'error') {
    return entry.error ?? 'Creation failed'
  }
  return getCreationProgressLabel(entry)
}

/**
 * Sidebar row for an in-progress (or failed) worktree create. Rendered inline in
 * the worktree list under its target repo, so the new workspace appears where it
 * will land. Self-contained: reads its own entry + active state by creationId.
 */
export function PendingWorktreeRow({
  creationId
}: {
  creationId: string
}): React.JSX.Element | null {
  const entry = useAppStore((s) => s.pendingWorktreeCreations[creationId])
  const active = useAppStore((s) => s.activePendingCreationId === creationId)
  if (!entry) {
    return null
  }

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
        // worktree yet. activePendingCreationId drives the content loader instead.
        onClick={() => {
          const store = useAppStore.getState()
          store.setActivePendingWorktreeCreation(creationId)
          store.updatePendingWorktreeCreation(creationId, { loaderVisible: true })
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
        title={translate("auto.components.sidebar.PendingWorktreeRow.188f6922a0", "Cancel")}
        aria-label={translate("auto.components.sidebar.PendingWorktreeRow.af21e953d1", "Cancel worktree creation")}
        onClick={() => useAppStore.getState().removePendingWorktreeCreation(creationId)}
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
