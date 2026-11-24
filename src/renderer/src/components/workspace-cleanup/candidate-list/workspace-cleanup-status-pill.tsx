import React from 'react'
import { cn } from '@/lib/class-names'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'

export function getStatusPillToneClassName(tone: StatusPillTone): string | undefined {
  return cn(
    tone === 'neutral' && 'border-border bg-background text-muted-foreground',
    tone === 'ready' &&
      'border-status-success-border bg-status-success-background text-status-success',
    tone === 'review' &&
      'border-status-warning-border bg-status-warning-background text-status-warning-text',
    tone === 'destructive' && 'border-destructive/30 text-destructive'
  )
}

export function StatusPill({
  children,
  tone = 'neutral',
  toneClassName,
  className,
  tabIndex
}: {
  children: React.ReactNode
  tone?: StatusPillTone
  /** Overrides `tone` for pills whose color comes from a domain state (e.g. review state). */
  toneClassName?: string
  className?: string
  tabIndex?: number
}): React.JSX.Element {
  return (
    <span
      tabIndex={tabIndex}
      className={cn(
        'inline-flex h-5 min-w-0 items-center rounded-full border px-2 text-[11px] font-medium',
        getStatusPillToneClassName(tone),
        toneClassName,
        className
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}
