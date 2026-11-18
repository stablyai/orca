import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'

/** The bots UI's fold arrow, as the sidebar's sections draw it: right while folded, down while open. */
export function BotFoldChevron({
  open,
  className
}: {
  open: boolean
  /** Size and hover color, which differ by row. */
  className?: string
}): React.JSX.Element {
  return (
    <ChevronDown
      aria-hidden
      className={cn(
        // Never the click target: a rotated arrow would sit over a row's stretched button.
        'pointer-events-none shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
        !open && '-rotate-90',
        className
      )}
    />
  )
}
