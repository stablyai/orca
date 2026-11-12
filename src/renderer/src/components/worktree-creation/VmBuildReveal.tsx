import type React from 'react'
import { cn } from '@/lib/class-names'

/** Grows and fades content in and out without a height jump; still under reduced motion. */
export function VmBuildReveal({
  open,
  className,
  children
}: {
  open: boolean
  /** Spacing that belongs to the revealed content, so a closed reveal adds none. */
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0">
        <div
          className={cn(
            // Tailwind's translate-y-* sets `translate`, not `transform`.
            'transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none',
            className,
            open ? 'translate-y-0 opacity-100 delay-75' : '-translate-y-1 opacity-0'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
