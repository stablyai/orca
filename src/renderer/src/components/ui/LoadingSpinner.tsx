import React from 'react'
import { Hourglass, Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { handleSpinnerAnimationStart } from '@/components/ui/spinner-phase'

function observeSpinner(el: HTMLSpanElement): () => void {
  return observeOffscreenAnimation(el)
}

// Reduced motion uses an hourglass rather than a stuck spinner. Hide it only when motion is allowed; hidden plus motion-reduce:block left it hidden.
// The span rotates, not the svg: Chromium can't composite an SVG transform animation, so a spinning svg forces a renderer frame every refresh.
export function LoadingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <>
      <span
        ref={observeSpinner}
        onAnimationStart={handleSpinnerAnimationStart}
        aria-hidden="true"
        className={cn('loading-spinner inline-block shrink-0 motion-reduce:hidden', className)}
      >
        <Loader2 className="block size-full" />
      </span>
      <Hourglass aria-hidden="true" className={cn('motion-safe:hidden', className)} />
    </>
  )
}
