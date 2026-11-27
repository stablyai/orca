import React from 'react'
import { CircleAlert, LoaderCircle, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { AutoNameFailure } from '../identity/use-auto-name-failure'

/** The hover card's failed auto-name section: why it failed, with Try again and Dismiss. */
export function WorktreeCardAutoNameFailureSection({
  failure
}: {
  failure: AutoNameFailure
}): React.JSX.Element {
  const t = useTranslate()
  const { retrying, canRetry, canDismiss, dismissing, reason } = failure
  const tryAgain = t('auto.components.sidebar.AutoRenameFailedDialog.tryAgain', 'Try again')
  const dismiss = t('auto.components.sidebar.AutoNameFailed.dismiss', 'Dismiss')
  return (
    <section className="flex items-start gap-2" data-worktree-card-auto-name-failure="">
      <span
        className={retrying ? 'mt-0.5 text-muted-foreground' : 'mt-0.5 text-destructive'}
        aria-hidden
      >
        {retrying ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <CircleAlert className="size-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="font-medium leading-snug text-foreground">
          {retrying
            ? t('auto.components.sidebar.AutoNameFailed.naming', 'Naming this workspace…')
            : t('auto.components.sidebar.AutoNameFailed.title', 'Couldn’t auto-name')}
        </div>
        {retrying ? null : <div className="leading-snug text-muted-foreground">{reason}</div>}
      </div>
      {canRetry || canDismiss ? (
        <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
          {canRetry ? (
            <AutoNameAction
              label={tryAgain}
              disabled={retrying || dismissing}
              busy={retrying}
              onClick={failure.tryAgain}
            >
              <RotateCw />
            </AutoNameAction>
          ) : null}
          {canDismiss ? (
            <AutoNameAction
              label={dismiss}
              disabled={retrying || dismissing}
              onClick={failure.dismiss}
            >
              <X />
            </AutoNameAction>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function AutoNameAction({
  label,
  disabled = false,
  busy = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  busy?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-xs"
          aria-label={label}
          // aria-disabled, not disabled: a native disabled button drops focus and its tooltip.
          aria-disabled={disabled || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (!disabled) {
              onClick()
            }
          }}
          className="[&_svg]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
