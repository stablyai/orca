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
// Horizontally the room is the 1rem gutter, so the box and its scrollbar end at the window edge.
const SHADOW_ROOM_Y_PX = 24

const STACK_STYLE: React.CSSProperties & Record<`--${string}`, string> = {
  '--stack-shadow-room-y': `${SHADOW_ROOM_Y_PX}px`,
  padding: `${SHADOW_ROOM_Y_PX}px 1rem`,
  bottom: `calc(${NOTIFICATION_CARD_STACK_BOTTOM} - ${SHADOW_ROOM_Y_PX}px)`,
  maxHeight: `calc(100vh - 2.5rem - ${NOTIFICATION_CARD_STACK_BOTTOM} + ${2 * SHADOW_ROOM_Y_PX}px)`
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
      const height = stack.offsetHeight - 2 * SHADOW_ROOM_Y_PX
      // Overflowing cards scroll; clip them to the original band so they stay off the status bar.
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
      className="notification-card-stack pointer-events-none fixed right-0 z-50 flex w-[calc(360px_+_2rem)] max-w-[100vw] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek data-overflowing:[clip-path:inset(var(--stack-shadow-room-y)_0)] [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-0 max-[480px]:w-auto [&_[data-slot=card]]:border-(--notice-border) [&_[data-slot=card]]:shadow-notice"
    >
      {children}
    </div>
  )
}
