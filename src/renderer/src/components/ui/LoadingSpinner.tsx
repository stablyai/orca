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
  // Without a caller size the svg keeps its parent's svg sizing (e.g. Button's [&_svg]) and the span wraps it.
  const sized = className?.split(/\s+/).some((name) => /(^|:)size-/.test(name)) ?? false
  return (
    <>
      <span
        ref={observeSpinner}
        onAnimationStart={handleSpinnerAnimationStart}
        aria-hidden="true"
        className={cn('loading-spinner inline-flex shrink-0 motion-reduce:hidden', className)}
      >
        <Loader2 className={sized ? 'block size-full' : 'block'} />
      </span>
      <Hourglass aria-hidden="true" className={cn('motion-safe:hidden', className)} />
    </>
  )
}
