import { useEffect, useState } from 'react'
import {
  LinkStatusBubble,
  type BrowserLinkTarget
} from '../assemble-chrome/feedback/browser-link-status-bubble'

// Matches main's refresh for local guests (browser-guest-target-url.ts).
const POINTER_REFRESH_MS = 100

/** The host reports a streamed page's hovered link; the pointer is this pane's own. */
export function RemoteBrowserLinkStatusBubble({
  browserPageId,
  targetUrl,
  viewportRef
}: {
  browserPageId: string
  targetUrl: string
  viewportRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const [pointer, setPointer] = useState<BrowserLinkTarget['pointer']>(null)
  // Follow the pointer only while a link is targeted, at most once per refresh interval.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !targetUrl) {
      return
    }
    let lastAt = -Infinity
    const follow = (event: PointerEvent): void => {
      if (event.timeStamp - lastAt < POINTER_REFRESH_MS) {
        return
      }
      lastAt = event.timeStamp
      setPointer({ x: event.clientX, y: event.clientY })
    }
    viewport.addEventListener('pointermove', follow)
    return () => viewport.removeEventListener('pointermove', follow)
  }, [targetUrl, viewportRef])
  return <LinkStatusBubble browserPageId={browserPageId} target={{ url: targetUrl, pointer }} />
}
