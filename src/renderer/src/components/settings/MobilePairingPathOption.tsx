import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Why: bespoke radio row instead of SettingsSegmentedControl — needs two-line
// title + description + trailing badge (STYLEGUIDE "real difference in role").
export function MobilePairingPathOption({
  selected,
  onSelect,
  title,
  description,
  trailing,
  tabIndex,
  disabled = false,
  positionInSet,
  setSize,
  optionRef
}: {
  selected: boolean
  onSelect: () => void
  title: string
  description: string
  trailing?: ReactNode
  tabIndex: number
  disabled?: boolean
  /** Stated explicitly: the Sign in panel sits between the radios in the DOM. */
  positionInSet: number
  setSize: number
  optionRef?: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <div
      ref={optionRef}
      role="radio"
      tabIndex={tabIndex}
      aria-checked={selected}
      aria-disabled={disabled}
      aria-posinset={positionInSet}
      aria-setsize={setSize}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(event) => {
        if (disabled) {
          return
        }
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2.5 outline-none transition-colors',
        // Why: match SettingsFormControls focus ring when selected uses bg-accent/40.
        'focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        disabled && 'cursor-not-allowed opacity-60',
        selected ? 'bg-accent/40' : 'hover:bg-accent/20'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-foreground bg-foreground' : 'border-muted-foreground/40'
        )}
        aria-hidden
      >
        {selected ? <span className="size-1.5 rounded-full bg-background" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium leading-none">{title}</span>
          {trailing}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
