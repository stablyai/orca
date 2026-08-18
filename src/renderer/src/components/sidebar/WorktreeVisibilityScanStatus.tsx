import type React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type Props = {
  state: 'checking' | 'ready' | 'failed'
  retryDisabled: boolean
  onRetry: () => void
}

export function WorktreeVisibilityScanStatus({
  state,
  retryDisabled,
  onRetry
}: Props): React.JSX.Element | null {
  if (state === 'checking') {
    return (
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeVisibilityDialog.a3f19c07d2', 'Checking…')}
      </p>
    )
  }
  if (state !== 'failed') {
    return null
  }
  return (
    <div className="flex min-w-0 items-center gap-3" role="alert">
      <p className="min-w-0 flex-1 text-xs text-destructive">
        {translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.b8d24e61f5',
          "Could not list this repo's worktrees."
        )}
      </p>
      <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={onRetry}>
        {translate('auto.components.sidebar.WorktreeVisibilityDialog.c5e70a93b1', 'Try again')}
      </Button>
    </div>
  )
}
