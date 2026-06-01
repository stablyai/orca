import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'

export function DeleteWorktreeWarningPanels({
  isMainWorktree,
  mainWorktreeBlocker,
  deleteError,
  dirtyDeleteSummary
}: {
  isMainWorktree: boolean
  mainWorktreeBlocker: string
  deleteError: string | null
  dirtyDeleteSummary: { worktreeCount: number; changeCount: number; targetCount: number } | null
}): JSX.Element {
  const isSingleDirtyTarget =
    dirtyDeleteSummary?.worktreeCount === 1 && dirtyDeleteSummary.targetCount === 1
  const changeLabel =
    dirtyDeleteSummary && dirtyDeleteSummary.changeCount > 0
      ? `${dirtyDeleteSummary.changeCount} uncommitted or untracked ${
          dirtyDeleteSummary.changeCount === 1 ? 'change' : 'changes'
        }`
      : 'uncommitted or untracked changes'
  const dirtyDescription = isSingleDirtyTarget
    ? `This workspace has ${changeLabel}. Deleting it will permanently remove those changes from disk.`
    : dirtyDeleteSummary?.worktreeCount === 1
      ? `1 workspace has ${changeLabel}. Deleting it will permanently remove those changes from disk.`
      : `${dirtyDeleteSummary?.worktreeCount ?? 0} workspaces have ${changeLabel}. Deleting them will permanently remove those changes from disk.`

  return (
    <>
      {isMainWorktree && (
        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              This is the <span className="font-semibold text-foreground">main worktree</span> (the
              original clone directory). {mainWorktreeBlocker}
            </div>
          </div>
        </div>
      )}

      {dirtyDeleteSummary && !isMainWorktree && (
        <div className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Uncommitted or untracked changes</div>
              <div className="mt-0.5 text-destructive/90">{dirtyDescription}</div>
            </div>
          </div>
        </div>
      )}

      {deleteError && !isMainWorktree && (
        <div className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-all">{deleteError}</div>
          </div>
        </div>
      )}
    </>
  )
}
