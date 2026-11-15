import { useEffect, useRef, type ReactNode } from 'react'
import {
  NOTIFICATION_CARD_STACK_BOTTOM,
  NOTIFICATION_CARD_STACK_HEIGHT_VAR
} from '@/lib/notifications/notification-card-stack-height'
import {
  registerNotificationCardLayoutVarReader,
  setNotificationCardLayoutVar
} from '@/lib/notifications/notification-card-layout-vars'

// Why: the scroll box clips, so it pads out (offset back) to show card shadows; the room collapses while it scrolls.
const SHADOW_ROOM_Y_PX = 40
const ROOM_Y = 'var(--stack-shadow-room-y)'

const STACK_STYLE: React.CSSProperties & Record<`--${string}`, string> = {
  '--stack-shadow-room-y': `${SHADOW_ROOM_Y_PX}px`,
  padding: `${ROOM_Y} 1rem`,
  bottom: `calc(${NOTIFICATION_CARD_STACK_BOTTOM} - ${ROOM_Y})`,
  maxHeight: `calc(100vh - 2.5rem - ${NOTIFICATION_CARD_STACK_BOTTOM} + 2 * ${ROOM_Y})`
}

export function NotificationCardStack({ children }: { children: ReactNode }): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stack = stackRef.current
    if (!stack) {
      return
    }
    const unregister = registerNotificationCardLayoutVarReader(stack)
    // Why publish: toasts share this corner and would otherwise render behind the cards (z-50).
    const publish = (): void => {
      const overflowing = stack.hasAttribute('data-overflowing')
      const height = stack.offsetHeight - (overflowing ? 0 : 2 * SHADOW_ROOM_Y_PX)
      // Toggling swaps padding for max-height, so the content height published above stays valid.
      stack.toggleAttribute('data-overflowing', stack.scrollHeight - stack.clientHeight > 1)
      setNotificationCardLayoutVar(
        NOTIFICATION_CARD_STACK_HEIGHT_VAR,
        height > 0 ? `calc(${height}px + 0.5rem)` : null
      )
    }
    publish()
    // Why each card too: once the box hits max-height, a growing card no longer resizes the box.
    const observer = new ResizeObserver(publish)
    observer.observe(stack)
    for (const card of stack.children) {
      observer.observe(card)
    }
    const cardList = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            observer.observe(node)
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element) {
            observer.unobserve(node)
          }
        }
      }
      publish()
    })
    cardList.observe(stack, { childList: true })
    window.addEventListener('resize', publish)
    return () => {
      cardList.disconnect()
      observer.disconnect()
      window.removeEventListener('resize', publish)
      setNotificationCardLayoutVar(NOTIFICATION_CARD_STACK_HEIGHT_VAR, null)
      unregister()
    }
  }, [])

  return (
    <div
      ref={stackRef}
      style={STACK_STYLE}
      className="notification-card-stack pointer-events-none fixed right-0 z-50 flex w-[calc(360px_+_2rem)] max-w-[100vw] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek data-overflowing:[--stack-shadow-room-y:0px]! [&>*]:pointer-events-auto [&>*]:relative [&>*]:z-[calc(10_-_sibling-index())] [&>*]:shrink-0 max-[480px]:left-0 max-[480px]:w-auto [&_[data-slot=card]]:border-(--notice-border) [&_[data-slot=card]]:shadow-notice"
    >
      {children}
    </div>
  )
}
