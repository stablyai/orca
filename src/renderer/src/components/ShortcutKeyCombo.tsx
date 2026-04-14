import React from 'react'

function KeyCap({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
      {label}
    </span>
  )
}

type ShortcutKeyComboProps = {
  keys: string[]
  separatorClassName?: string
}

export function ShortcutKeyCombo({
  keys,
  separatorClassName
}: ShortcutKeyComboProps): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <div className="flex items-center gap-1">
      {keys.map((key, index) => (
        <React.Fragment key={`${key}-${index}`}>
          <KeyCap label={key} />
          {/* Why: Orca renders Mac shortcuts as adjacent glyphs, but Windows/Linux
              shortcuts read more naturally with explicit "+" separators. */}
          {!isMac && index < keys.length - 1 ? (
            <span className={separatorClassName ?? 'mx-0.5 text-xs text-muted-foreground'}>+</span>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  )
}
