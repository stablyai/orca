import React from 'react'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { handleSpinnerAnimationStart } from '@/components/ui/shared-animation-clock'

// Offscreen rings drop their animation; the restart on reveal re-anchors phase via animationstart.
function observeSpinner(el: HTMLSpanElement): () => void {
  return observeOffscreenAnimation(el)
}

// CSS compositor rotation avoids JS input-thread work; callers provide size.
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      ref={observeSpinner}
      onAnimationStart={handleSpinnerAnimationStart}
      data-agent-spinner=""
      className={cn(
        // Fill the top under reduced motion so the frozen ring looks intentional (#9515).
        'agent-working-spinner block rounded-full border-2 border-agent-working border-t-transparent motion-reduce:border-t-agent-working',
        className
      )}
    />
  )
}
