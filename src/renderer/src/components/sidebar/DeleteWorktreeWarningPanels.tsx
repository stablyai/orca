import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'

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
              <Trans
                i18n={i18n}
                defaults={translate(
                  'auto.components.sidebar.DeleteWorktreeWarningPanels.mainWorktreeNotice',
                  'This is the <strong>main worktree</strong> (the original clone directory).'
                )}
                components={{ strong: <span className="font-semibold text-foreground" /> }}
              />
              {mainWorktreeBlocker ? <> {mainWorktreeBlocker}</> : null}
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
