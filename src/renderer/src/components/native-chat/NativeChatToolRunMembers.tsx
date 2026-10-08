import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { distanceFromBottom, NATIVE_CHAT_FOLLOW_REARM_PX } from './native-chat-autoscroll'
import { setWithLRU } from '@/lib/scroll-cache'
import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  NativeChatDisclosureContext
} from './native-chat-disclosure-store'

/** The height of every detail a reader has opened in a member, each marked by its owner. */
function openDetailHeight(content: HTMLElement): number {
  let height = 0
  for (const detail of content.querySelectorAll<HTMLElement>('[data-native-chat-member-detail]')) {
    height += detail.offsetHeight
  }
  return height
}

/** Scrolls a member to the top of its run's box. Returns the box for the transcript to
 *  align to: a member's own offset ignores the box's scroll. */
export function revealNativeChatToolRunMember(member: HTMLElement): HTMLElement {
  const scroller = member.closest<HTMLElement>('[data-native-chat-tool-run-members]')
  if (!scroller) {
    return member
  }
  scroller.scrollTop += member.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  return scroller
}

/** An opened run's members in a bounded scroll box, so live work fills it instead of lengthening the page. */
export function NativeChatToolRunMembers({
  followKey,
  startsAtEnd,
  memoryKey,
  children
}: {
  /** How much work the run holds: a reader at the end follows it growing. Opening a detail must not count. */
  followKey: number
  /** A live run opens on what it is doing now; a settled one reads from its top. */
  startsAtEnd: boolean
  /** The run's disclosure key. Windowing unmounts an off-screen row; its box comes back as the reader left it. */
  memoryKey?: string
  children: React.ReactNode
}): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // An edge fades while members lie past it, so a full box reads as scrollable.
  const [fades, setFades] = useState({ top: false, bottom: false })
  const runScroll = useContext(NativeChatDisclosureContext)?.runScroll
  const [remembered] = useState(() =>
    memoryKey === undefined ? undefined : runScroll?.get(memoryKey)
  )
  const followsEndRef = useRef(remembered?.followsEnd ?? startsAtEnd)

  useLayoutEffect(() => {
    if (scrollerRef.current && remembered && !remembered.followsEnd) {
      scrollerRef.current.scrollTop = remembered.top
    }
  }, [remembered])

  // Before paint: follow only if the reader was at the end before the new work.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller && followsEndRef.current) {
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [followKey])

  const readPosition = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }
    const fromEnd = distanceFromBottom(scroller)
    followsEndRef.current = fromEnd <= NATIVE_CHAT_FOLLOW_REARM_PX
    const top = scroller.scrollTop > 1
    const bottom = fromEnd > 1
    setFades((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom }
    )
    if (runScroll && memoryKey !== undefined) {
      setWithLRU(
        runScroll,
        memoryKey,
        { top: scroller.scrollTop, followsEnd: followsEndRef.current },
        MAX_NATIVE_CHAT_DISCLOSURES
      )
    }
  }, [memoryKey, runScroll])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    let roomForDetails = 0
    const observer = new ResizeObserver(() => {
      const opened = openDetailHeight(content)
      if (opened !== roomForDetails) {
        roomForDetails = opened
        // A variable, not state: a detail animating open would re-render every frame.
        scroller.style.setProperty('--native-chat-opened-detail', `${opened}px`)
      }
      readPosition()
    })
    observer.observe(content)
    // The box's cap moves with an opened detail, which changes what lies past its edges.
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [readPosition])

  return (
    // Indented under the header: nothing else marks where the run's rows end.
    <div
      ref={scrollerRef}
      onScroll={readPosition}
      className={cn(
        'scrollbar-sleek ml-[7px] mt-0.5 overflow-y-auto border-l border-chat-code-border pl-[13px]',
        // Contains the members' absolute sr-only labels, which otherwise lengthen the page.
        'relative',
        // Room for the list plus what the reader has opened in it, up to half the window.
        'max-h-[min(50dvh,calc(18rem+var(--native-chat-opened-detail,0px)))]',
        fades.top && 'mask-t-from-[calc(100%-1.5rem)]',
        fades.bottom && 'mask-b-from-[calc(100%-1.5rem)]'
      )}
      data-native-chat-tool-run-members
    >
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
