import { useEffect, useRef, type ReactNode } from 'react'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from '@/lib/notification-card-stack-height'

export function NotificationCardStack({ children }: { children: ReactNode }): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stack = stackRef.current
    if (!stack) {
      return
    }
    const root = stack.ownerDocument.documentElement
    // Why publish: toasts share this corner and would otherwise render behind the cards (z-50).
    const publish = (): void => {
      const height = stack.offsetHeight
      if (height > 0) {
        root.style.setProperty(NOTIFICATION_CARD_STACK_HEIGHT_VAR, `calc(${height}px + 0.5rem)`)
      } else {
        root.style.removeProperty(NOTIFICATION_CARD_STACK_HEIGHT_VAR)
      }
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(stack)
    return () => {
      observer.disconnect()
      root.style.removeProperty(NOTIFICATION_CARD_STACK_HEIGHT_VAR)
    }
  }, [])

  return (
    <div
      ref={stackRef}
      className="pointer-events-none fixed bottom-10 right-4 z-50 flex max-h-[calc(100vh-80px)] w-[360px] max-w-[calc(100vw-32px)] flex-col-reverse gap-2 overflow-y-auto scrollbar-sleek [&>*]:pointer-events-auto [&>*]:shrink-0 max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto"
    >
      {children}
    </div>
  )
}
