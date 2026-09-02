import React from 'react'
import { Slot } from 'radix-ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Clears the pointer without putting the label under the cursor's own hotspot.
const CURSOR_TOOLTIP_GAP = 18

/**
 * Radix positions the tooltip against the trigger, so a cursor position has to
 * be restated as offsets from the trigger's bottom-left corner to land under
 * the pointer.
 */
export function cursorTooltipOffsets(
  pointer: { x: number; y: number },
  trigger: { bottom: number; left: number }
): { align: number; side: number } {
  return {
    align: pointer.x - trigger.left,
    side: pointer.y + CURSOR_TOOLTIP_GAP - trigger.bottom
  }
}

/**
 * Splits a path for filename-first display, keeping the separator attached to
 * the directory so `/foo` renders `foo` + `/` and Windows paths keep `\`.
 */
export function splitTrailingSegment(path: string): { directory: string; filename: string } {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return separatorIndex === -1
    ? { directory: '', filename: path }
    : { directory: path.slice(0, separatorIndex + 1), filename: path.slice(separatorIndex + 1) }
}

/**
 * Wraps a single result row so its full path appears in a system-styled tooltip
 * anchored under the cursor. The child is the trigger; it receives a ref and a
 * pointer-move handler.
 */
export function FilePathCursorTooltip({
  children,
  path
}: {
  children: React.ReactNode
  path: string
}): React.JSX.Element {
  const triggerRef = React.useRef<HTMLElement>(null)
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null)
  const [open, setOpen] = React.useState(false)
  const [offset, setOffset] = React.useState({ align: 0, side: 0 })

  // Why: the offsets are only valid for the trigger's position at the moment
  // Radix positions it. Results stream in and move rows while the open delay
  // runs, so re-measure on open rather than trusting the pointer-move rect.
  React.useLayoutEffect(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    const pointer = pointerRef.current
    if (!open || !rect || !pointer) {
      return
    }
    const next = cursorTooltipOffsets(pointer, rect)
    setOffset((current) =>
      current.align === next.align && current.side === next.side ? current : next
    )
  }, [open])

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Slot.Root
          ref={triggerRef}
          // Why: a ref, not state — read once when the tooltip opens, so
          // re-rendering per pointer move would be churn for nothing.
          // pointermove (not mousemove) because Radix opens off pointermove and
          // Slot runs the child handler first, keeping this fresh on instant open.
          onPointerMove={(event: React.PointerEvent) => {
            if (open) {
              return
            }
            pointerRef.current = { x: event.clientX, y: event.clientY }
          }}
        >
          {children}
        </Slot.Root>
      </TooltipTrigger>
      {/* Anchored under the cursor the way a system tooltip is, rather than to
          the row. Collision shifting still applies near the viewport edge. */}
      <TooltipContent
        side="bottom"
        align="start"
        sideOffset={offset.side}
        alignOffset={offset.align}
        showArrow={false}
        className="max-w-[min(90vw,800px)] rounded-md border border-border/80 bg-popover px-2 py-1 text-[11px] leading-[15px] break-words text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
      >
        {path}
      </TooltipContent>
    </Tooltip>
  )
}
