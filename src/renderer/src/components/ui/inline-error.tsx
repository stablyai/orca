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
  className
}: InlineErrorProps): React.JSX.Element {
  const Icon = tone === 'error' ? CircleAlert : Info
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-slot="inline-error"
      className={cn(
        'flex gap-3 rounded-lg border px-3 py-2.5 text-sm',
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
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">{title}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      {onRetry && retryLabel ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={retrying ? undefined : onRetry}
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          className="shrink-0 aria-disabled:pointer-events-none"
        >
          <RotateCw className={cn(retrying && 'motion-safe:animate-spin')} aria-hidden />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}

export { InlineError }
