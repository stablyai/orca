import { useLayoutEffect, useRef, useState } from 'react'
import { revealInSettingsList } from './settings-list-scroll'

const SETTINGS_LIST_MAX_HEIGHT = 'min(440px, 40vh)'

export function SettingsScrollList({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) {
      return
    }
    const measure = (): void => {
      const max = scroller.scrollHeight - scroller.clientHeight
      const top = max > 1 && scroller.scrollTop > 1
      const bottom = max > 1 && scroller.scrollTop < max - 1
      setEdges((previous) =>
        previous.top === top && previous.bottom === bottom ? previous : { top, bottom }
      )
    }
    // Portaled rows bubble React events through their owner, so listen on the physical scroller.
    const focus = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement) {
        revealInSettingsList(event.target)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(content)
    scroller.addEventListener('scroll', measure, { passive: true })
    scroller.addEventListener('focusin', focus)
    measure()
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', measure)
      scroller.removeEventListener('focusin', focus)
    }
  }, [])
  return (
    <div
      ref={scrollerRef}
      data-settings-scroll-list=""
      role="region"
      aria-label={label}
      className="scrollbar-sleek -mx-5 overflow-y-auto overscroll-auto px-5 [scroll-padding-block:24px] [overflow-anchor:none]"
      style={{
        maxHeight: SETTINGS_LIST_MAX_HEIGHT,
        maskImage:
          edges.top || edges.bottom
            ? `linear-gradient(to bottom, ${edges.top ? 'transparent, black 24px' : 'black 0px'}, ${edges.bottom ? 'black calc(100% - 24px), transparent' : 'black 100%'})`
            : undefined
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
