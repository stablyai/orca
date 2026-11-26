import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'

/** A one-line title that ellipsizes, and scrolls to its end while it or its row is hovered or
 *  focused, only when it overflows; the motion is CSS (main.css `.hover-scroll-text`). */
export function HoverScrollText({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const chars = typeof children === 'string' ? children.length : 60
  const style: React.CSSProperties & Record<'--hover-scroll-duration', string> = {
    '--hover-scroll-duration': `${Math.max(1.5, chars * 0.06)}s`
  }
  return (
    <span className={cn('hover-scroll-text', className)} style={style}>
      <span>
        <span>{children}</span>
      </span>
    </span>
  )
}
