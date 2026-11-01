import { useEffect, useRef, type ReactNode } from 'react'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'
import {
  measureComposerClearance,
  NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR,
  NOTIFICATION_CARD_STACK_BOTTOM,
  subscribeToComposerLayout
} from '@/lib/notification-card-composer-clearance'
import {
  registerNotificationCardLayoutVarReader,
  setNotificationCardLayoutVar
} from '@/lib/notification-card-layout-vars'

const STACK_STYLE = {
  bottom: NOTIFICATION_CARD_STACK_BOTTOM,
  maxHeight: `calc(100vh - 2.5rem - ${NOTIFICATION_CARD_STACK_BOTTOM})`
}

export function NotificationCardStack({ children }: { children: ReactNode }): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stack = stackRef.current
    if (!stack) {
      return
    }
    const root = stack.ownerDocument.documentElement
    const unregister = registerNotificationCardLayoutVarReader(stack)
    // Why publish: toasts share this corner and would otherwise render behind the cards (z-50).
    const publish = (): void => {
      const height = stack.offsetHeight
      // Why clear a composer: with the right sidebar closed the cards cover its Send and Stop.
      const restingBottom = 2.5 * Number.parseFloat(getComputedStyle(root).fontSize)
      const clearance =
        height > 0
          ? measureComposerClearance(
              stack.getBoundingClientRect(),
              window.innerHeight - restingBottom - height,
              window.innerHeight
            )
          : 0
      setNotificationCardLayoutVar(
        NOTIFICATION_CARD_STACK_HEIGHT_VAR,
        height > 0 ? `calc(${height}px + 0.5rem)` : null
      )
      setNotificationCardLayoutVar(
        NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR,
        clearance > 0 ? `calc(${clearance}px + 0.5rem)` : null
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(stack)
    const unsubscribe = subscribeToComposerLayout(publish)
    window.addEventListener('resize', publish)
    return () => {
      observer.disconnect()
      unsubscribe()
      window.removeEventListener('resize', publish)
      setNotificationCardLayoutVar(NOTIFICATION_CARD_STACK_HEIGHT_VAR, null)
      setNotificationCardLayoutVar(NOTIFICATION_CARD_COMPOSER_CLEARANCE_VAR, null)
      unregister()
    }
  }, [])

  return (
    <div
      ref={stackRef}
      style={STACK_STYLE}
      className="pointer-events-none fixed right-4 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto"
    >
      {children}
    </div>
  )
}
