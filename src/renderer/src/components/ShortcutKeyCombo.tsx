import React from 'react'
import { cn } from '@/lib/utils'

function KeyCap({ label, className }: { label: string; className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm',
        className
      )}
    >
      {label}
    </span>
  )
}

type ShortcutKeyComboProps = {
  keys: string[]
  className?: string
  separatorClassName?: string
  // Override cap colors when chips sit on a non-default surface (e.g. a filled primary card).
  keyCapClassName?: string
}

export function ShortcutKeyCombo({
  keys,
  className,
  separatorClassName,
  keyCapClassName
}: ShortcutKeyComboProps): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((key, index) => (
        <React.Fragment key={`${key}-${index}`}>
          <KeyCap label={key} className={keyCapClassName} />
          {/* Why: Orca renders Mac shortcuts as adjacent glyphs, but Windows/Linux
              shortcuts read more naturally with explicit "+" separators. */}
          {!isMac && index < keys.length - 1 ? (
            <span className={separatorClassName ?? 'mx-0.5 text-xs text-muted-foreground'}>+</span>
          ) : null}
        </React.Fragment>
      ))}
    </span>
  )
}
