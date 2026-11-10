import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { BROWSER_PAGE_ZOOM_FEEDBACK_MS } from '../describe-page/browser-annotation-geometry'

export type BrowserPageFeedbackBadgeHandle = {
  flash: (label: string) => void
  hide: () => void
}

/** Transient corner badge for page zoom and viewport size changes. */
export function BrowserPageFeedbackBadge({
  ref
}: {
  ref: Ref<BrowserPageFeedbackBadgeHandle>
}): React.JSX.Element {
  // Why state lives here: a resize drag flashes every frame, and only the badge should re-render.
  const [label, setLabel] = useState('')
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])
  useImperativeHandle(
    ref,
    () => ({
      flash: (next: string) => {
        setLabel(next)
        setVisible(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setVisible(false), BROWSER_PAGE_ZOOM_FEEDBACK_MS)
      },
      hide: () => {
        clearTimeout(timerRef.current)
        setVisible(false)
      }
    }),
    []
  )
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={cn(
        'pointer-events-none absolute top-3 right-3 z-30 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-xs transition-opacity duration-300 ease-out',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      {label}
    </div>
  )
}
