import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function DeleteWorktreeWarningPanels({
  isMainWorktree,
  mainWorktreeBlocker,
  deleteError
}: {
  isMainWorktree: boolean
  mainWorktreeBlocker: string
  deleteError: string | null
}): JSX.Element {
  return (
    <>
      {isMainWorktree && (
        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              {translate(
                'auto.components.sidebar.DeleteWorktreeWarningPanels.e3be9eba15',
                'This is the'
              )}
              <span className="font-semibold text-foreground">
                {translate(
                  'auto.components.sidebar.DeleteWorktreeWarningPanels.c4f96a6e18',
                  'main worktree'
                )}
              </span>{' '}
              {translate(
                'auto.components.sidebar.DeleteWorktreeWarningPanels.026738155a',
                '(the original clone directory).'
              )}
              {mainWorktreeBlocker}
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
