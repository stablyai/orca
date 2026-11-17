import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import * as DialogPrimitive from 'radix-ui/dialog'

import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from './button'
import { useDialogLayout } from './dialog-layout-context'

/** The footer's Cancel: outline, closes the dialog, and is off while the dialog is busy. */
function DialogCancel({
  children,
  disabled,
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  const t = useTranslate()
  const { busy } = useDialogLayout()
  return (
    <DialogPrimitive.Close asChild>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-dialog-cancel=""
        disabled={busy || disabled}
        {...props}
      >
        {children ?? t('components.ui.dialog.cancel', 'Cancel')}
      </Button>
    </DialogPrimitive.Close>
  )
}

/** One red line above the footer, never a box; `onRetry` adds "Try again". */
function DialogError({
  children,
  onRetry,
  retryLabel,
  className,
  ...props
}: React.ComponentProps<'p'> & { onRetry?: () => void; retryLabel?: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p
      role="alert"
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 text-[13px] break-words text-destructive',
        className
      )}
      {...props}
    >
      <span className="min-w-0">{children}</span>
      {onRetry ? (
        <button
          type="button"
          className="rounded-sm font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          {retryLabel ?? t('components.ui.dialog.tryAgain', 'Try again')}
        </button>
      ) : null}
    </p>
  )
}

/** One amber line that keeps a warning's meaning without a box or icon. */
function DialogWarning({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      data-slot="dialog-warning"
      className={cn('text-[12.5px] leading-normal text-status-warning-text', className)}
      {...props}
    />
  )
}

/** A collapsed "Details" / "Show changes" section. */
function DialogDisclosure({
  label,
  children,
  defaultOpen = false,
  variant = 'boxed'
}: {
  label: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  /** `code`: a scrolling monospace list (changed files, diagnostics). `plain`: form fields, no box. */
  variant?: 'boxed' | 'code' | 'plain'
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen)
  const contentId = React.useId()
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit items-center gap-1 rounded-sm text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        {label}
      </button>
      <div
        id={contentId}
        hidden={!open}
        className={cn(
          'min-w-0',
          variant !== 'plain' &&
            'rounded-lg border border-input px-2.5 py-2 text-[11px] leading-normal text-muted-foreground',
          variant === 'code' && 'scrollbar-sleek max-h-44 overflow-y-auto font-mono'
        )}
      >
        {children}
      </div>
    </div>
  )
}

export { DialogCancel, DialogDisclosure, DialogError, DialogWarning }
