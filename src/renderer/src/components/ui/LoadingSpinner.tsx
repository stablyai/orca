import React from 'react'
import { Hourglass, Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'

// Reduced motion uses an hourglass rather than a stuck spinner. Hide it only when motion is allowed; hidden plus motion-reduce:block left it hidden.
// The span rotates, not the svg: Chromium can't composite an SVG transform animation, so a spinning svg repaints the page every frame.
export function LoadingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('inline-block shrink-0 animate-spin motion-reduce:hidden', className)}
      >
        <Loader2 className="block size-full" />
      </span>
      <Hourglass aria-hidden="true" className={cn('motion-safe:hidden', className)} />
    </>
  )
}
