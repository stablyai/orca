import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { cn } from '@/lib/class-names'

/** A timeline cue as the attribute the card's CSS reads. */
export function on(shown: boolean): { 'data-on'?: '' } {
  return shown ? { 'data-on': '' } : {}
}

/** A chat held at its end: as rows grow in, older ones move up under the faded top edge. */
export function BotsTipScroll({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const outer = box.current
    const content = inner.current
    if (!outer || !content) {
      return
    }
    const follow = (): void => {
      const overflow = Math.max(0, content.scrollHeight - outer.clientHeight)
      content.style.transform = `translateY(${-overflow}px)`
    }
    follow()
    // Rows grow over a few frames; every size change keeps the newest one in view.
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    observer.observe(outer)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={box} className={cn('bt-scroll', className)}>
      <div ref={inner} className="bt-scroll-inner">
        {children}
      </div>
    </div>
  )
}

/** Grows its height open when shown, so the rows above it move up as in a chat. */
export function Grow({
  shown,
  className,
  children
}: {
  shown: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="bt-grow" {...on(shown)}>
      <div className={className}>{children}</div>
    </div>
  )
}
