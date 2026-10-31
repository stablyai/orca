import type { Ref } from 'react'
import { cn } from '@/lib/utils'

/** The one bounded, vertically scrolling frame every previewed body shares; it never takes focus. */
export function TerminalFilePeekBodyScroll({
  ref,
  className,
  children
}: {
  ref?: Ref<HTMLDivElement>
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        'max-h-[min(18rem,40vh)] overflow-x-hidden overflow-y-auto overscroll-contain scrollbar-sleek',
        className
      )}
    >
      {children}
    </div>
  )
}
