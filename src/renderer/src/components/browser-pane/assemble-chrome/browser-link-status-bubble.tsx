import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { windowDipToCssPx } from '@/lib/ui-zoom'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'

// Chrome's status bubble timings (status_bubble_views.cc, status_bubble.h).
const SHOW_DELAY_MS = 80
const HIDE_DELAY_MS = 250
const EXPAND_DELAY_MS = 1600
const POINTER_PADDING_PX = 20
const TAIL_CHARS = 20
const MAX_HEAD_CHARS = 512

type LinkStatus = {
  text: string
  visible: boolean
  expanded: boolean
  pointer: { x: number; y: number } | null
}

const HIDDEN: LinkStatus = { text: '', visible: false, expanded: false, pointer: null }

/** Splits a URL so CSS ellipsis trims its middle: the head keeps the origin, the tail the end. */
function splitLinkStatusText(text: string): { head: string; tail: string } {
  const cut = Math.max(originLength(text), text.length - TAIL_CHARS)
  const head = cut > MAX_HEAD_CHARS ? `${text.slice(0, MAX_HEAD_CHARS)}…` : text.slice(0, cut)
  return { head, tail: text.slice(cut) }
}

function originLength(text: string): number {
  try {
    const { origin } = new URL(text)
    if (origin !== 'null' && text.startsWith(origin)) {
      return origin.length
    }
  } catch {
    // Not a parseable URL; keep the scheme at least.
  }
  return text.indexOf(':') + 1
}

export function BrowserLinkStatusBubble({
  browserPageId
}: {
  browserPageId: string
}): React.JSX.Element {
  const [status, setStatus] = useState<LinkStatus>(HIDDEN)
  const [side, setSide] = useState<'left' | 'right'>('left')
  const bubbleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let lastUrl = ''
    let showTimer: number | undefined
    let hideTimer: number | undefined
    let expandTimer: number | undefined
    const clearTimers = (): void => {
      window.clearTimeout(showTimer)
      window.clearTimeout(hideTimer)
      window.clearTimeout(expandTimer)
    }
    const unsubscribe = window.api.browser.onTargetUrlChanged((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      const pointer = {
        x: windowDipToCssPx(event.screenX - window.screenX),
        y: windowDipToCssPx(event.screenY - window.screenY)
      }
      // Main repeats the URL while the pointer moves within one link; only the pointer changed.
      if (event.url && event.url === lastUrl) {
        setStatus((current) => ({ ...current, pointer }))
        return
      }
      lastUrl = event.url
      clearTimers()
      const text = event.url ? toDisplayUrl(event.url) : ''
      if (!text) {
        hideTimer = window.setTimeout(() => {
          setStatus((current) => ({ ...current, visible: false, expanded: false }))
        }, HIDE_DELAY_MS)
        return
      }
      setStatus((current) => ({ ...current, text, pointer }))
      showTimer = window.setTimeout(() => {
        setStatus((current) => (current.visible ? current : { ...current, visible: true }))
      }, SHOW_DELAY_MS)
      expandTimer = window.setTimeout(() => {
        setStatus((current) => ({ ...current, expanded: true }))
      }, EXPAND_DELAY_MS)
    })
    return () => {
      unsubscribe()
      clearTimers()
    }
  }, [browserPageId])

  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    const page = bubble?.offsetParent
    if (!bubble || !page || !status.pointer) {
      return
    }
    // Like Firefox, step to the other corner when the link under the pointer sits where the bubble would.
    const pageRect = page.getBoundingClientRect()
    const { x, y } = status.pointer
    const overLeftCorner =
      x >= pageRect.left &&
      x <= pageRect.left + bubble.offsetWidth + POINTER_PADDING_PX &&
      y <= pageRect.bottom &&
      y >= pageRect.bottom - bubble.offsetHeight - POINTER_PADDING_PX
    setSide(overLeftCorner ? 'right' : 'left')
    if (overLeftCorner) {
      // A bubble that stepped aside stays narrow so it can't grow back under the pointer.
      setStatus((current) => (current.expanded ? { ...current, expanded: false } : current))
    }
  }, [status.text, status.pointer, status.expanded])

  const { head, tail } = useMemo(() => splitLinkStatusText(status.text), [status.text])
  return (
    <div
      ref={bubbleRef}
      aria-hidden
      data-browser-link-status={side}
      className={cn(
        'pointer-events-none absolute bottom-1 z-30 flex rounded-md border border-border bg-popover/95 px-2 py-0.5 text-xs text-popover-foreground shadow-xs transition-opacity ease-out',
        side === 'left' ? 'left-1' : 'right-1',
        status.expanded
          ? 'max-w-[calc(100%-0.5rem)]'
          : 'max-w-[min(calc(100%-0.5rem),max(33%,20rem))]',
        status.visible ? 'opacity-100 duration-100' : 'opacity-0 duration-200'
      )}
    >
      <span className="truncate">{head}</span>
      <span className="shrink-0 whitespace-nowrap">{tail}</span>
    </div>
  )
}
