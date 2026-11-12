import React from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

function KeyCap({
  label,
  className
}: {
  label: React.ReactNode
  className?: string
}): React.JSX.Element {
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
  renderKey?: (key: string) => React.ReactNode
  // Double taps use repeated labels/glyphs with a space instead of +.
  doubleTap?: boolean
}

export function ShortcutKeyCombo({
  keys,
  className,
  separatorClassName,
  keyCapClassName,
  renderKey,
  doubleTap = false
}: ShortcutKeyComboProps): React.JSX.Element {
  const t = useTranslate()
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      title={
        doubleTap && keys.length > 0
          ? t('auto.components.ShortcutKeyCombo.07eb4985a1', 'Double-tap {{value0}}', {
              value0: keys[0]
            })
          : undefined
      }
    >
      {keys.map((key, index) => (
        <React.Fragment key={`${key}-${index}`}>
          <KeyCap label={renderKey ? renderKey(key) : key} className={keyCapClassName} />
          {/* Mac uses adjacent glyphs; Windows/Linux use +. Double taps use a space. */}
          {!isMac && !doubleTap && index < keys.length - 1 ? (
            <span className={separatorClassName ?? 'mx-0.5 text-xs text-muted-foreground'}>+</span>
          ) : null}
        </React.Fragment>
      ))}
    </span>
  )
}
