import { useEffect, useRef, type ReactNode } from 'react'
import {
  NOTIFICATION_CARD_STACK_BOTTOM,
  NOTIFICATION_CARD_STACK_HEIGHT_VAR
} from '@/lib/notifications/notification-card-stack-height'
import {
  registerNotificationCardLayoutVarReader,
  setNotificationCardLayoutVar
} from '@/lib/notifications/notification-card-layout-vars'

// Why: the scroll box clips overflow, so it pads out (and offsets back) to keep card shadows visible.
const SHADOW_ROOM = '1.5rem'

const STACK_STYLE: React.CSSProperties & Record<`--${string}`, string> = {
  '--stack-shadow-room': SHADOW_ROOM,
  padding: SHADOW_ROOM,
  bottom: `calc(${NOTIFICATION_CARD_STACK_BOTTOM} - ${SHADOW_ROOM})`,
  maxHeight: `calc(100vh - 2.5rem - ${NOTIFICATION_CARD_STACK_BOTTOM} + 2 * ${SHADOW_ROOM})`
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
      const stackStyle = getComputedStyle(stack)
      const height =
        stack.offsetHeight -
        Number.parseFloat(stackStyle.paddingTop) -
        Number.parseFloat(stackStyle.paddingBottom)
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
      className="notification-card-stack pointer-events-none fixed right-[calc(1rem_-_var(--stack-shadow-room))] z-50 flex w-[calc(360px_+_2*var(--stack-shadow-room))] max-w-[calc(100vw_-_32px_+_2*var(--stack-shadow-room))] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-[calc(1rem_-_var(--stack-shadow-room))] max-[480px]:right-[calc(1rem_-_var(--stack-shadow-room))] max-[480px]:w-auto [&_[data-slot=card]]:border-(--notice-border) [&_[data-slot=card]]:shadow-notice"
    >
      {children}
    </div>
  )
}
