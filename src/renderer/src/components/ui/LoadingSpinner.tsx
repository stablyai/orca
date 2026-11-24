import React from 'react'
import { Hourglass, Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { handleSpinnerAnimationStart } from '@/components/ui/shared-animation-clock'

function observeSpinner(el: HTMLSpanElement): () => void {
  return observeOffscreenAnimation(el)
}

// Rotate this span, not the svg inside: Chromium can't composite an SVG transform animation, so a spinning svg forces a renderer frame every refresh.
export function SpinnerFrame({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      ref={observeSpinner}
      onAnimationStart={handleSpinnerAnimationStart}
      aria-hidden="true"
      className={cn('loading-spinner inline-flex shrink-0', className)}
    >
      {children}
    </span>
  )
}

// Reduced motion uses an hourglass rather than a stuck spinner. Hide it only when motion is allowed; hidden plus motion-reduce:block left it hidden.
export function LoadingSpinner({ className }: { className?: string }): React.JSX.Element {
  // Without a caller size the svg keeps its parent's svg sizing (e.g. Button's [&_svg]) and the span wraps it.
  const sized = className?.split(/\s+/).some((name) => /(^|:)(size|h|w)-/.test(name)) ?? false
  return (
    <>
      <SpinnerFrame className={cn('motion-reduce:hidden', className)}>
        <Loader2 className={sized ? 'block size-full' : 'block'} />
      </SpinnerFrame>
      <Hourglass aria-hidden="true" className={cn('motion-safe:hidden', className)} />
    </>
  )
}
