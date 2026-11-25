import { memo, useEffect, useRef, useState } from 'react'
import { LINK_STATUS_POINTER_REFRESH_MS } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import {
  LinkStatusBubble,
  type BrowserLinkTarget
} from '../assemble-chrome/feedback/browser-link-status-bubble'

/** The host reports a streamed page's hovered link; the pointer is this pane's own. */
export const RemoteBrowserLinkStatusBubble = memo(function RemoteBrowserLinkStatusBubble({
  browserPageId,
  targetUrl,
  viewportRef
}: {
  browserPageId: string
  targetUrl: string
  viewportRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const [pointer, setPointer] = useState<BrowserLinkTarget['pointer']>(null)
  const lastPointerRef = useRef<BrowserLinkTarget['pointer']>(null)
  const followingRef = useRef(false)
  // The host's report trails the move that hovered the link, so remember every move.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    let lastAt = -Infinity
    const track = (event: PointerEvent): void => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      // While a link is targeted, refresh the bubble at most once per interval.
      if (followingRef.current && event.timeStamp - lastAt >= LINK_STATUS_POINTER_REFRESH_MS) {
        lastAt = event.timeStamp
        setPointer(lastPointerRef.current)
      }
    }
    viewport.addEventListener('pointermove', track)
    return () => viewport.removeEventListener('pointermove', track)
  }, [viewportRef])
  useEffect(() => {
    followingRef.current = targetUrl !== ''
    if (targetUrl) {
      setPointer(lastPointerRef.current)
    }
  }, [targetUrl])
  return <LinkStatusBubble browserPageId={browserPageId} target={{ url: targetUrl, pointer }} />
})
