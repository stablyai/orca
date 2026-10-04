import type { JSX } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type { DeleteWorktreeDirtyChangePreview } from './delete-worktree-dirty-change-counts'

export function DeleteWorktreeDirtyChangeHint({
  changeCount,
  preview
}: {
  changeCount: number | undefined
  preview?: DeleteWorktreeDirtyChangePreview
}): JSX.Element | null {
  if (changeCount === undefined) {
    return null
  }

  const label =
    changeCount > 0
      ? `${changeCount} uncommitted or untracked ${changeCount === 1 ? 'change' : 'changes'}`
      : 'Uncommitted or untracked changes'

  const warning = translate(
    'auto.components.sidebar.DeleteWorktreeDirtyChangeHint.8e2994ce28',
    'Deleting this workspace permanently removes these changes from disk.'
  )
  const warningLabel = (
    <>
      <AlertTriangle className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-medium">{label}</span>
    </>
  )

  if (!preview?.files.length) {
    return (
      <div className="mt-1 min-w-0">
        <div className="flex w-fit max-w-full items-center gap-1.5 text-destructive">
          {warningLabel}
        </div>
        <p className="mt-1 text-muted-foreground">{warning}</p>
      </div>
    )
  }

  return (
    <Collapsible className="mt-1 min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${translate('auto.components.sidebar.DeleteWorktreeDirtyChangeHint.showLoadedPaths', 'Show loaded paths')}`}
          className="group flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {warningLabel}
          <ChevronRight className="size-3 shrink-0 group-data-[state=open]:rotate-90" />
        </button>
      </CollapsibleTrigger>
      <p className="mt-1 text-muted-foreground">{warning}</p>
      <CollapsibleContent>
        <div className="mt-1 min-w-0 rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
