// @protected-copy
import type { JSX } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import { STATUS_COLORS } from '../../../../lib/source-control/paths/git-path-decoration'
import { STATUS_LABELS } from '../../../../../../shared/git/status/git-status-labels'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'
import { DeleteWorktreeRelativePath } from './delete-worktree-relative-path'

export function DeleteWorktreeDirtyChangeHint({
  changeCount,
  checkState,
  preview
}: {
  changeCount: number | undefined
  checkState?: DeleteWorktreeChangeCheckState
  preview?: DeleteWorktreeDirtyChangePreview
}): JSX.Element | null {
  const t = useTranslate()
  if (changeCount === undefined) {
    if (!checkState) {
      return null
    }
    const statusLabel =
      checkState === 'complete'
        ? t('components.workspace.delete.changes.none', 'No uncommitted changes')
        : checkState === 'unavailable'
          ? t('components.workspace.delete.changes.unavailable', 'Changes could not be checked')
          : t('components.workspace.delete.changes.checking', 'Checking for changes…')
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center text-muted-foreground">
        <span className="truncate">{statusLabel}</span>
      </div>
    )
  }

  const label =
    changeCount > 0
      ? t(
          'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.changesLost',
          '{{count}} uncommitted changes will be lost',
          { count: changeCount, defaultValue_one: '{{count}} uncommitted change will be lost' }
        )
      : t(
          'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.uncountedChangesLost',
          'Uncommitted changes will be lost'
        )

  if (!preview?.files.length) {
    const detailsLabel =
      checkState === 'checking'
        ? t('components.workspace.delete.changes.checkingDetails', 'Checking…')
        : checkState === 'unavailable'
          ? t('components.workspace.delete.changes.unavailableDetails', 'Details unavailable')
          : null
    return (
      <div className="mt-0.5 flex h-4 min-w-0 items-center">
        <div className="flex w-fit max-w-full items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-medium">{label}</span>
          {detailsLabel && <span className="shrink-0 text-muted-foreground">· {detailsLabel}</span>}
        </div>
      </div>
    )
  }

  const loadedPathsLabel = t(
    'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedChangedPaths',
    'Loaded changed paths'
  )

  return (
    <Collapsible className="mt-0.5 min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${t('auto.components.sidebar.DeleteWorktreeDirtyChangeHint.showLoadedPaths', 'Show loaded paths')}`}
          className="group flex h-4 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <AlertTriangle className="size-3 shrink-0 text-destructive" />
          <span className="min-w-0 truncate font-medium text-destructive group-hover:underline">
            {label}
          </span>
          <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-all duration-150 group-hover:text-foreground group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div className="pt-1.5">
          <div
            role="region"
            aria-label={loadedPathsLabel}
            tabIndex={0}
            className="scrollbar-sleek max-h-40 min-w-0 overflow-y-auto rounded-sm border border-border/60 bg-background/60 px-2.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ul className="min-w-0 space-y-1 font-mono text-xs">
              {preview.files.map((file) => (
                <li key={file.path} className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="w-3 shrink-0 font-semibold"
                    style={{ color: STATUS_COLORS[file.status] }}
                    aria-label={file.status}
                  >
                    {STATUS_LABELS[file.status]}
                  </span>
                  <div className="min-w-0 wrap-anywhere text-foreground">
                    <DeleteWorktreeRelativePath path={file.path} />
                    {file.hasUnresolvedConflict ? (
                      <span className="ml-2 font-sans text-destructive">
                        {t(
                          'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.unresolvedConflict',
                          'Unresolved conflict'
                        )}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {preview.remainingPathCount > 0 ? (
              <p className="mt-1.5 border-t border-border/50 pt-1 text-2xs text-muted-foreground">
                {t(
                  'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.moreLoadedPaths',
                  'and {{count}} more loaded paths',
                  {
                    count: preview.remainingPathCount,
                    defaultValue_one: 'and {{count}} more loaded path'
                  }
                )}
              </p>
            ) : null}
            <p className="mt-1 text-2xs text-muted-foreground">
              {t(
                'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.loadedPathsNotice',
                'Loaded paths may be incomplete or out of date.'
              )}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
