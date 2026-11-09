import type React from 'react'
import { CircleAlert, Info, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

type InlineErrorProps = {
  /** What went wrong, in one sentence. */
  title: React.ReactNode
  /** Optional detail or next step, shown muted under the title. */
  detail?: React.ReactNode
  /** 'error' for failures; 'neutral' for soft states such as "status unavailable". */
  tone?: 'error' | 'neutral'
  /** Label for the retry action; the button only renders with onRetry. */
  retryLabel?: React.ReactNode
  onRetry?: () => void
  retrying?: boolean
  /** 'compact' for narrow panels (sidebar sections): tighter padding, xs text. */
  density?: 'default' | 'compact'
  /** 'toast' leaves room for the toast's own dismiss button and puts the action under the text.
   *  'strip-top' / 'strip-bottom' run edge to edge at the top or bottom of a framed panel. */
  layout?: 'inline' | 'toast' | 'strip-top' | 'strip-bottom'
  /** A next step other than retry (e.g. "Sign in"), rendered inside the box after the text.
   *  Pass an outline xs Button with a short verb-first label; never a primary button. */
  action?: React.ReactNode
  className?: string
}

/**
 * One pattern for a section that failed to load or save: icon, foreground title, muted detail and
 * an outline retry. Errors are announced as alerts; neutral notices as status. An alert only
 * re-announces when its text changes, so key it on the attempt when a retry fails the same way.
 */
function InlineError({
  title,
  detail,
  tone = 'error',
  retryLabel,
  onRetry,
  retrying = false,
  density = 'default',
  layout = 'inline',
  action,
  className
}: InlineErrorProps): React.JSX.Element {
  const Icon = tone === 'error' ? CircleAlert : Info
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-slot="inline-error"
      className={cn(
        // Wraps so a narrow box (e.g. a hint under a half-width field) puts its button under the text
        // instead of squeezing the text to one word per line.
        'flex flex-wrap border',
        layout === 'strip-top'
          ? 'rounded-none border-x-0 border-t-0'
          : layout === 'strip-bottom'
            ? 'rounded-none border-x-0 border-b-0'
            : 'rounded-lg',
        density === 'compact' ? 'gap-2 px-2.5 py-2 text-xs' : 'gap-3 px-3 py-2.5 text-sm',
        layout === 'toast' && 'pr-9',
        detail ? 'items-start' : 'items-center',
        tone === 'error'
          ? 'border-destructive/15 bg-destructive/5 dark:border-destructive/25'
          : 'border-border bg-muted/40',
        className
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          detail && 'mt-0.5',
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
        aria-hidden
      />
      <div className="min-w-[10rem] flex-1 basis-0 space-y-0.5">
        <p className="font-medium text-foreground">{title}</p>
        {detail ? (
          <p
            className={cn(
              'text-muted-foreground',
              // Compact titles are already xs, so the detail steps down to keep the hierarchy.
              density === 'compact' ? 'text-2xs' : 'text-xs'
            )}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          className={cn(
            'flex shrink-0 items-center gap-2',
            // Under the text, aligned with the title (icon width + gap).
            layout === 'toast' ? 'basis-full ps-7' : 'ms-auto'
          )}
        >
          {action}
        </div>
      ) : null}
      {onRetry && retryLabel ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={retrying ? undefined : onRetry}
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          className="ms-auto shrink-0 aria-disabled:pointer-events-none"
        >
          <RotateCw className={cn(retrying && 'motion-safe:animate-spin')} aria-hidden />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}

export { InlineError }
