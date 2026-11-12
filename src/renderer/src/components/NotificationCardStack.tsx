import { useEffect, useRef, type ReactNode } from 'react'
import {
  NOTIFICATION_CARD_STACK_BOTTOM,
  NOTIFICATION_CARD_STACK_HEIGHT_VAR
} from '@/lib/notifications/notification-card-stack-height'
import {
  registerNotificationCardLayoutVarReader,
  setNotificationCardLayoutVar
} from '@/lib/notifications/notification-card-layout-vars'

// Why: a scroll box clips its overflow, so it pads out (and offsets back) to keep card shadows visible.
// Horizontally the room is the 1rem gutter, so the box and its scrollbar end at the window edge;
// vertically it collapses while the cards scroll, so they never slide over the status bar.
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
      // Toggling resizes the box, so the observer republishes with the matching padding.
      stack.toggleAttribute('data-overflowing', stack.scrollHeight > stack.clientHeight)
      setNotificationCardLayoutVar(
        NOTIFICATION_CARD_STACK_HEIGHT_VAR,
        height > 0 ? `calc(${height}px + 0.5rem)` : null
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(stack)
    window.addEventListener('resize', publish)
    return () => {
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
