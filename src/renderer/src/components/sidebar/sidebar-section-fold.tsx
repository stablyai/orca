import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'

/** The fold arrow of a top-level sidebar section header; it lights up with the header's `peer` fold button. */
export function SidebarSectionFoldChevron({
  collapsed
}: {
  collapsed: boolean
}): React.JSX.Element {
  return (
    <span className="pointer-events-none ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors peer-hover:bg-accent/70 peer-hover:text-foreground">
      <ChevronDown
        className={cn(
          'size-3.5 transition-transform motion-reduce:transition-none',
          collapsed && '-rotate-90'
        )}
      />
    </span>
  )
}
