import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ZOOM_LEVEL_CHANGED_EVENT } from '@/lib/zoom-events'
import type { ZoomLevelChangedEventDetail } from '@/lib/zoom-events'

// Why: the overlay must fully unmount after its fade-out completes so the
// fixed-position container doesn't linger in the DOM and interfere with
// Radix portal layering, click-outside detection, or focus management
// used by dropdowns, context menus, and dialogs elsewhere in the app.
const DISPLAY_MS = 1500
const FADE_MS = 300

export function ZoomOverlay(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [detail, setDetail] = useState<ZoomLevelChangedEventDetail | null>(null)
  const hideTimerRef = useRef<number | undefined>(undefined)
  const unmountTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const onZoomLevelChanged = (e: Event): void => {
      const customEvent = e as CustomEvent<ZoomLevelChangedEventDetail>
      setDetail(customEvent.detail)
      setVisible(true)

      window.clearTimeout(hideTimerRef.current)
      window.clearTimeout(unmountTimerRef.current)

      hideTimerRef.current = window.setTimeout(() => {
        setVisible(false)
        // Clear detail after the CSS fade-out transition finishes so the
        // component fully unmounts and removes the fixed overlay from the DOM.
        unmountTimerRef.current = window.setTimeout(() => {
          setDetail(null)
        }, FADE_MS)
      }, DISPLAY_MS)
    }

    window.addEventListener(ZOOM_LEVEL_CHANGED_EVENT, onZoomLevelChanged)
    return () => {
      window.removeEventListener(ZOOM_LEVEL_CHANGED_EVENT, onZoomLevelChanged)
      window.clearTimeout(hideTimerRef.current)
      window.clearTimeout(unmountTimerRef.current)
    }
  }, [])

  if (!detail) {
    return null
  }

  const title =
    detail.type === 'ui' ? 'UI Zoom' : detail.type === 'editor' ? 'Editor Zoom' : 'Terminal Zoom'

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div
        className={`flex items-center gap-3 rounded-full bg-popover/95 px-5 py-2.5 text-popover-foreground shadow-2xl border border-border/50 backdrop-blur-md transition-transform duration-300 ease-out ${
          visible ? 'scale-100 translate-y-0' : 'scale-95 translate-y-4'
        }`}
      >
        <Search className="size-4 text-muted-foreground" />
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <span className="text-sm font-bold tabular-nums">{detail.percent}%</span>
        </div>
      </div>
    </div>
  )
}
