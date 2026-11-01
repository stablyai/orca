import React from 'react'
import * as Slot from 'radix-ui/slot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Clears the pointer without putting the label under the cursor's own hotspot.
const CURSOR_TOOLTIP_GAP = 18

/** Convert cursor coordinates to Radix offsets from the trigger’s bottom-left corner. */
export function cursorTooltipOffsets(
  pointer: { x: number; y: number },
  trigger: { bottom: number; left: number }
): { align: number; side: number } {
  return {
    align: pointer.x - trigger.left,
    side: pointer.y + CURSOR_TOOLTIP_GAP - trigger.bottom
  }
}

/** Keep the directory separator when splitting filename-first display, including Windows paths. */
export function splitTrailingSegment(path: string): { directory: string; filename: string } {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return separatorIndex === -1
    ? { directory: '', filename: path }
    : { directory: path.slice(0, separatorIndex + 1), filename: path.slice(separatorIndex + 1) }
}

export function FilenameFirstPath({ path }: { path: string }): React.JSX.Element {
  const { directory, filename } = splitTrailingSegment(path)

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {/* Truncate the directory before sacrificing filename width. */}
      <span className="min-w-0 max-w-full shrink-0 truncate">{filename}</span>
      {directory ? (
        <span className="min-w-0 truncate text-muted-foreground/70">{directory}</span>
      ) : null}
    </span>
  )
}

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

  // Streaming results can move rows during the open delay; remeasure before positioning.
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
          // Use a ref to avoid per-move renders; pointermove matches Radix and Slot updates it before instant open.
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
      {/* Anchor to the cursor while retaining viewport collision handling. */}
      <TooltipContent
        data-cursor-tooltip=""
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
