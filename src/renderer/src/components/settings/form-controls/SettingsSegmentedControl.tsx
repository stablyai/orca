import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '@/lib/class-names'

type SegmentedOption<T extends string | number> = {
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
  size?: 'icon' | 'sm' | 'md'
  equalWidth?: boolean
  wrap?: boolean
  overlayTooltip?: boolean
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
  overlayTooltip = false
}: SettingsSegmentedControlProps<T>): React.JSX.Element {
  const enabled = options.filter((opt) => !opt.disabled)
  // One tab stop: the checked option, or the first available one when none is checked.
  const tabStop = options.some((opt) => opt.value === value) ? value : enabled[0]?.value
  // Radio-group keys: arrows (and Home/End) move to the next available option and pick it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: T): void => {
    const index = options.findIndex((opt) => opt.value === current)
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    let next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : undefined
    for (let offset = 1; direction && offset <= options.length; offset++) {
      const candidate = options[(index + direction * offset + options.length) % options.length]
      if (!candidate.disabled) {
        next = candidate
        break
      }
    }
    if (!next) {
      return
    }
    event.preventDefault()
    const group = event.currentTarget.closest('[role="radiogroup"]')
    const buttons = group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')] : []
    buttons[options.indexOf(next)]?.focus()
    onChange(next.value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-background/50 p-0.5',
        size === 'icon' && 'gap-0.5',
        equalWidth && 'w-full',
        wrap && 'flex-wrap'
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const button = (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            // Keep unavailable options focusable for explanatory tooltips; the click guard enforces aria-disabled.
            aria-disabled={opt.disabled}
            tabIndex={opt.value === tabStop ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, opt.value)}
            onClick={() => {
              if (!opt.disabled) {
                onChange(opt.value)
              }
            }}
            className={cn(
              'rounded-sm text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              size === 'icon'
                ? 'grid h-[26px] w-7 place-items-center'
                : size === 'sm'
                  ? 'px-2.5 py-0.5 text-xs'
                  : 'px-3 py-1 text-sm',
              equalWidth && 'flex-1',
              active
                ? 'bg-accent font-medium text-accent-foreground'
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
            <TooltipContent
              side="top"
              sideOffset={4}
              style={overlayTooltip ? { zIndex: 110 } : undefined}
            >
              {opt.tooltip}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
