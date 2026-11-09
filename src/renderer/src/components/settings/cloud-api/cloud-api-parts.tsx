import { useEffect, useRef, useState } from 'react'
import type { AlertCircle } from 'lucide-react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { RoutineRunStatus } from '../../../../../shared/cloud-api/cloud-api-types'
import { routineRunStatusLabel, routineRunTone, type RoutineRunTone } from './cloud-api-copy'

const COPIED_RESET_MS = 2000

async function writeClipboard(value: string): Promise<void> {
  if (window.api?.ui?.writeClipboardText) {
    await window.api.ui.writeClipboardText(value)
    return
  }
  await navigator.clipboard.writeText(value)
}

/** Copy with a visible + announced "Copied" state; the label names what is copied for screen readers. */
export function CopyValueButton({
  value,
  label,
  variant = 'outline',
  size = 'xs',
  className,
  onCopied,
  idleText,
  autoFocus
}: {
  value: string
  /** e.g. "Copy MCP URL". */
  label: string
  variant?: 'outline' | 'ghost' | 'default'
  size?: 'xs' | 'sm'
  className?: string
  onCopied?: () => void
  /** Visible text before copying; defaults to "Copy". */
  idleText?: string
  /** One-time secrets land focus on Copy, the one thing to do next. */
  autoFocus?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )
  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(value)
      setState('copied')
      onCopied?.()
    } catch {
      setState('failed')
    }
    if (timer.current) {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(() => setState('idle'), COPIED_RESET_MS)
  }
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn('min-w-[4.75rem]', className)}
        aria-label={label}
        autoFocus={autoFocus}
        onClick={() => void copy()}
      >
        {state === 'copied' ? <Check className="text-status-success" /> : <Copy />}
        {state === 'copied'
          ? t('auto.components.settings.cloudApi.copied', 'Copied')
          : state === 'failed'
            ? t('auto.components.settings.cloudApi.copyFailed', 'Copy failed')
            : (idleText ?? t('auto.components.settings.cloudApi.copy', 'Copy'))}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied'
          ? t('auto.components.settings.cloudApi.copiedAnnouncement', 'Copied to clipboard')
          : state === 'failed'
            ? t('auto.components.settings.cloudApi.copyFailedAnnouncement', 'Could not copy')
            : ''}
      </span>
    </>
  )
}

/** The shared InlineError, worded from a CloudApiErrorCode upstream. */
export function CloudApiErrorNotice({
  message,
  onRetry,
  className
}: {
  message: string
  onRetry?: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <InlineError
      title={message}
      onRetry={onRetry}
      retryLabel={t('auto.components.settings.cloudApi.retry', 'Try again')}
      className={className}
    />
  )
}

/** Placeholder rows while a list loads; static under reduced motion. */
export function CloudApiSkeletonRows({
  rows = 3,
  label
}: {
  rows?: number
  label: string
}): React.JSX.Element {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} data-settings-row="" className="flex items-center gap-3 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5" style={{ width: `${40 - index * 6}%` }} />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function CloudApiEmptyState({
  icon: Icon,
  title,
  description,
  action
}: {
  icon: typeof AlertCircle
  title: string
  description: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
      <div className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Icon className="size-[18px]" aria-hidden />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}

const TONE_CLASSES: Record<RoutineRunTone, { pill: string; dot: string }> = {
  success: {
    pill: 'border-status-success-border bg-status-success-background text-status-success',
    dot: 'bg-status-success'
  },
  failure: {
    pill: 'border-destructive/30 bg-destructive/10 text-destructive',
    dot: 'bg-destructive'
  },
  active: {
    pill: 'border-callout-note/30 bg-callout-note/10 text-callout-note',
    dot: 'bg-callout-note animate-pulse motion-reduce:animate-none'
  },
  neutral: {
    pill: 'border-border bg-muted/40 text-muted-foreground',
    dot: 'bg-muted-foreground/70'
  }
}

export function RoutineRunStatusPill({
  status,
  className
}: {
  status: RoutineRunStatus
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const tone = TONE_CLASSES[routineRunTone(status)]
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        tone.pill,
        className
      )}
    >
      <span className={cn('size-1.5 rounded-full', tone.dot)} aria-hidden />
      {routineRunStatusLabel(status, t)}
    </span>
  )
}

/** A labelled form control; the label is a real <label> bound to the control id. */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
  className
}: {
  id: string
  label: React.ReactNode
  hint?: React.ReactNode
  error?: string | null
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function ScopeChip({ scope }: { scope: string }): React.JSX.Element {
  return (
    <span className="inline-flex h-5 items-center rounded border border-border/70 bg-muted/40 px-1.5 font-mono text-[10.5px] leading-none text-muted-foreground">
      {scope}
    </span>
  )
}
