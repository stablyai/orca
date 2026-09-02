import React from 'react'
import { cn } from '@/lib/utils'

type SidebarViewToggleOption = {
  value: string
  label: string
  /** Every label this slot can ever show; reserves width so switching never resizes the tab. */
  widthLabels?: readonly string[]
  sectionTitle?: string
  renderWrapper?: (button: React.ReactNode) => React.ReactNode
}

type SidebarViewToggleProps = {
  ariaLabel: string
  value: string
  options: readonly SidebarViewToggleOption[]
  onSelect: (value: string) => void
  className?: string
}

/** Two-up segmented control; tab widths stay frozen so nothing reflows on toggle. */
export function SidebarViewToggle({
  ariaLabel,
  value,
  options,
  onSelect,
  className
}: SidebarViewToggleProps): React.JSX.Element {
  const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  // Arrow keys must carry focus to the newly checked radio, or every later press
  // would still step from the old index and re-select the same neighbour.
  const selectAndFocus = (index: number): void => {
    const option = options[index]
    if (!option) {
      return
    }
    if (option.value !== value) {
      onSelect(option.value)
    }
    buttonRefs.current[index]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center rounded-lg border border-sidebar-border bg-sidebar-accent p-0.5 shadow-xs',
        className
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value
        const button = (
          <button
            key={option.value}
            ref={(element) => {
              buttonRefs.current[index] = element
            }}
            type="button"
            role="radio"
            tabIndex={active ? 0 : -1}
            aria-checked={active}
            data-sidebar-section-title={option.sectionTitle}
            onClick={() => {
              if (!active) {
                onSelect(option.value)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                selectAndFocus((index + 1) % options.length)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                selectAndFocus((index - 1 + options.length) % options.length)
              }
            }}
            className={cn(
              'relative grid grid-cols-1 rounded-md border px-1.5 py-0.5 text-center text-xs outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
              active
                ? 'border-sidebar-border bg-sidebar font-semibold text-sidebar-foreground shadow-xs'
                : 'border-transparent font-medium text-worktree-sidebar-foreground/65 hover:text-worktree-sidebar-foreground'
            )}
          >
            {(option.widthLabels ?? [option.label]).map((widthLabel) => (
              <span
                key={widthLabel}
                aria-hidden
                className="invisible col-start-1 row-start-1 whitespace-nowrap font-semibold"
              >
                {widthLabel}
              </span>
            ))}
            <span className="col-start-1 row-start-1 whitespace-nowrap">{option.label}</span>
          </button>
        )

        return option.renderWrapper ? (
          <React.Fragment key={option.value}>{option.renderWrapper(button)}</React.Fragment>
        ) : (
          button
        )
      })}
    </div>
  )
}
