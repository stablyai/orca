import type { JSX } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'

export function DeleteWorktreeDirtyChangeHint({
  changeCount,
  checkState,
  preview
}: {
  changeCount: number | undefined
  checkState?: DeleteWorktreeChangeCheckState
  preview?: DeleteWorktreeDirtyChangePreview
}): JSX.Element | null {
  if (changeCount === undefined) {
    if (!checkState) {
      return null
    }
    const statusLabel =
      checkState === 'complete'
        ? translate(
            'components.workspace.delete.changes.clean',
            'No uncommitted or untracked changes'
          )
        : checkState === 'unavailable'
          ? translate(
              'components.workspace.delete.changes.unavailable',
              'Changes could not be checked'
            )
          : translate('components.workspace.delete.changes.checking', 'Checking for changes…')
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center text-muted-foreground">
        <span className="truncate">{statusLabel}</span>
      </div>
    )
  }

  const label =
    changeCount > 0
      ? `${changeCount} uncommitted or untracked ${changeCount === 1 ? 'change' : 'changes'}`
      : 'Uncommitted or untracked changes'

  const warningLabel = (
    <>
      <AlertTriangle className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-medium">{label}</span>
    </>
  )

  if (!preview?.files.length) {
    const detailsLabel =
      checkState === 'checking'
        ? translate('components.workspace.delete.changes.checkingDetails', 'Checking…')
        : checkState === 'unavailable'
          ? translate(
              'components.workspace.delete.changes.unavailableDetails',
              'Details unavailable'
            )
          : null
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center">
        <div className="flex w-fit max-w-full items-center gap-1.5 text-destructive">
          {warningLabel}
          {detailsLabel && <span className="shrink-0 text-muted-foreground">· {detailsLabel}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-0.5 flex h-4 min-w-0 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${translate('auto.components.sidebar.DeleteWorktreeDirtyChangeHint.showLoadedPaths', 'Show loaded paths')}`}
            className="flex h-4 w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {warningLabel}
            <ChevronRight className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          aria-label={translate(
            'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedChangedPaths',
            'Loaded changed paths'
          )}
          className="w-80 max-w-[calc(100vw-2rem)]"
          wheelScroll
        >
          <div className="scrollbar-sleek max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-3 text-xs">
            <p className="mb-1 font-medium">
              {translate(
                'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedChangedPaths',
                'Loaded changed paths'
              )}
            </p>
            <p className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedPathsNotice',
                'Loaded paths may be incomplete or out of date.'
              )}
            </p>
            <div
              role="region"
              aria-label={translate(
                'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedChangedPaths',
                'Loaded changed paths'
              )}
              tabIndex={0}
              className="scrollbar-sleek mt-1 max-h-40 min-w-0 overflow-y-auto"
            >
              <ul className="min-w-0 space-y-0.5 font-mono">
                {preview.files.map((file) => (
                  <li key={file.path} className="flex min-w-0 items-baseline gap-2">
                    <span
                      className="w-3 shrink-0 font-semibold"
                      style={{ color: STATUS_COLORS[file.status] }}
                      aria-label={file.status}
                    >
                      {STATUS_LABELS[file.status]}
                    </span>
                    <div className="min-w-0 break-all text-foreground">
                      {file.path}
                      {file.hasUnresolvedConflict ? (
                        <span className="ml-2 font-sans text-destructive">
                          {translate(
                            'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.unresolvedConflict',
                            'Unresolved conflict'
                          )}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {preview.remainingPathCount > 0 ? (
              <p className="mt-1 text-muted-foreground">
                {translate(
                  'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.moreLoadedPaths',
                  'and {{value0}} more loaded paths',
                  { value0: preview.remainingPathCount }
                )}
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
