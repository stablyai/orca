import type React from 'react'
import { useRef } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '@/lib/utils'

export type SegmentedOption<T extends string | number> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
  ariaLabel?: string
  tooltip?: React.ReactNode
}

type SettingsSegmentedControlProps<T extends string | number> = {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  size?: 'sm' | 'md'
  equalWidth?: boolean
  wrap?: boolean
  /** 'auto' (default) selects on arrow keys; 'manual' only moves focus, for options whose change has side effects. */
  activation?: 'auto' | 'manual'
}

export function SettingsSegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  size = 'md',
  equalWidth = false,
  wrap = false,
  activation = 'auto'
}: SettingsSegmentedControlProps<T>): React.JSX.Element {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const activeIndex = options.findIndex((opt) => opt.value === value)
  // Radio-group semantics: one Tab stop (the checked option, else the first enabled one).
  const tabStopIndex =
    activeIndex !== -1
      ? activeIndex
      : Math.max(
          0,
          options.findIndex((opt) => !opt.disabled)
        )

  const moveTo = (from: number, step: 1 | -1 | 'first' | 'last'): void => {
    const count = options.length
    const order =
      step === 'first'
        ? options.map((_, i) => i)
        : step === 'last'
          ? options.map((_, i) => count - 1 - i)
          : Array.from({ length: count - 1 }, (_, i) => (from + step * (i + 1) + count * 2) % count)
    const next = order[0]
    if (next === undefined) {
      return
    }
    // Unavailable options still take focus so their tooltip explains why; only enabled ones select.
    buttonRefs.current[next]?.focus()
    if (activation === 'auto' && !options[next].disabled) {
      onChange(options[next].value)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const keyStep: Record<string, 1 | -1 | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last'
    }
    const step = keyStep[event.key]
    if (step === undefined || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    event.preventDefault()
    moveTo(index, step)
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className={cn(
        // A muted track with a raised chip keeps the selection visible in light, where fill alone is ~1.1:1.
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5 dark:bg-white/[0.03]',
        equalWidth && 'w-full',
        wrap && 'flex-wrap'
      )}
    >
      {options.map((opt, index) => {
        const active = opt.value === value
        const button = (
          <button
            key={String(opt.value)}
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            tabIndex={index === tabStopIndex ? 0 : -1}
            // Keep unavailable options focusable for explanatory tooltips; the click guard enforces aria-disabled.
            aria-disabled={opt.disabled}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => {
              if (!opt.disabled) {
                onChange(opt.value)
              }
            }}
            className={cn(
              // Every option is medium weight so labels keep their width when the selection moves.
              'rounded-sm text-center font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
              equalWidth && 'flex-1',
              active
                ? 'bg-background text-foreground shadow-xs ring-1 ring-border dark:bg-white/[0.11] dark:ring-white/[0.06]'
                : opt.disabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        )
        if (opt.tooltip == null) {
          return button
        }
        return (
          <Tooltip key={String(opt.value)}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{opt.tooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
