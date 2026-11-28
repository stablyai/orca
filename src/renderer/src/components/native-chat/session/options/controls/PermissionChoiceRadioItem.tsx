import { useId, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { DropdownMenuRadioItem, useDropdownMenuClose } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { lastPressWasTouch } from '@/lib/keyboard/keyboard-input-modality'

// The side tooltip needs a hover pointer and room beside the menu; otherwise (touch-only
// screens, narrow or zoomed windows) the description renders inline. One media rule per state,
// not `hidden` plus an override: another bundled stylesheet redefines `.hidden` later.
const INLINE_ONLY_WHEN_NEEDED = '[@media(width>=48rem)_and_(hover:hover)]:hidden'
const TOOLTIP_ONLY_WHEN_ROOM = 'max-md:hidden [@media(hover:none)]:hidden'

/**
 * One-line permission row. Its description is a hoverable side tooltip, inline when the menu was
 * opened by touch or there is no room, and always the row's accessible description.
 */
export function PermissionChoiceRadioItem({
  value,
  description,
  disabled,
  onSelect,
  children
}: {
  value: string
  description: string
  disabled?: boolean
  onSelect: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const descriptionId = useId()
  const closeMenu = useDropdownMenuClose()
  const [inline, setInline] = useState(lastPressWasTouch)
  const inlineRef = useRef<HTMLDivElement>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // Why: leaving a row moves menu focus to the menu itself; that blur must not close the
  // tooltip, so the pointer can travel onto it. Radix's hover grace area closes it instead.
  const keepOpenOnBlur = useRef(false)
  return (
    <Tooltip
      disableHoverableContent={false}
      open={tooltipOpen}
      onOpenChange={(next) => {
        if (!next && keepOpenOnBlur.current) {
          keepOpenOnBlur.current = false
          return
        }
        setTooltipOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <DropdownMenuRadioItem
          value={value}
          // Why not `disabled`: menus keep disabled items focusable so keyboard users can read why.
          aria-disabled={disabled || undefined}
          onSelect={(event) => {
            // Why: a tap can't hover, so the first tap on a row whose description is hidden
            // (a mouse-opened menu) shows it; the next tap selects.
            if (lastPressWasTouch() && !inlineRef.current?.getClientRects().length) {
              event.preventDefault()
              setInline(true)
              return
            }
            if (disabled) {
              event.preventDefault()
              return
            }
            onSelect()
          }}
          aria-describedby={descriptionId}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof HTMLElement &&
              event.relatedTarget.getAttribute('role') === 'menu'
            ) {
              // Radix closes the tooltip synchronously after this handler; if it was already
              // closed nothing consumes the flag, so drop it before a later close is skipped.
              keepOpenOnBlur.current = true
              queueMicrotask(() => {
                keepOpenOnBlur.current = false
              })
            }
          }}
        >
          <div className={cn('min-w-0', disabled && 'opacity-40')}>
            {children}
            <div
              ref={inlineRef}
              aria-hidden
              className={cn(
                'py-0.5 text-xs font-normal text-muted-foreground',
                !inline && INLINE_ONLY_WHEN_NEEDED
              )}
            >
              {description}
            </div>
            <span id={descriptionId} hidden>
              {description}
            </span>
          </div>
        </DropdownMenuRadioItem>
      </TooltipTrigger>
      {inline ? null : (
        <TooltipContent
          side="right"
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            'pointer-events-auto max-w-[min(16rem,var(--radix-tooltip-content-available-width))]',
            TOOLTIP_ONLY_WHEN_ROOM
          )}
          // Why: the tooltip is the top layer, so without this the first Escape closes only it.
          onEscapeKeyDown={closeMenu}
          // Why: the tooltip can't take focus, so a click on it would drop focus to the page and
          // leave the still-open menu deaf to arrow keys.
          onMouseDown={(event) => event.preventDefault()}
        >
          {description}
        </TooltipContent>
      )}
    </Tooltip>
  )
}
