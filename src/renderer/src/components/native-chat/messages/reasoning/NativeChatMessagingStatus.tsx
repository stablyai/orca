import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useState } from 'react'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import { useWindowStreamVisible } from '@/lib/window-activity/use-window-stream-visibility'
import { handleShimmerAnimationStart } from '@/components/ui/shared-animation-clock'

export function NativeChatMessagingStatus({
  id,
  label,
  visible
}: {
  id: string
  label: string
  visible: boolean
}): React.JSX.Element {
  const windowVisible = useWindowStreamVisible(0)
  const reducedMotion = usePrefersReducedMotion()
  const [held, setHeld] = useState<{ label: string; previous: string | null }>({
    label,
    previous: null
  })
  if (held.label !== label || (reducedMotion && held.previous !== null)) {
    setHeld({ label, previous: reducedMotion ? null : held.label })
  }
  return (
    <span
      id={id}
      ref={observeOffscreenAnimation}
      data-native-chat-motion-paused={visible && windowVisible ? undefined : ''}
      className="grid min-w-0 flex-1 text-sm text-chat-foreground"
    >
      {held.previous ? (
        <span
          aria-hidden
          className="native-chat-status-leave col-start-1 row-start-1 truncate"
          onAnimationEnd={() => setHeld((current) => ({ ...current, previous: null }))}
        >
          {held.previous}
        </span>
      ) : null}
      <span
        key={label}
        className="native-chat-status-enter col-start-1 row-start-1 min-w-0 truncate"
      >
        <span
          onAnimationStart={(event) => {
            if (
              !event.currentTarget.closest(
                '[data-animation-offscreen], [data-native-chat-motion-paused]'
              )
            ) {
              handleShimmerAnimationStart(event)
            }
          }}
          className={cn('shimmer shimmer-steps-24', (!visible || !windowVisible) && 'shimmer-none')}
        >
          {label}
        </span>
      </span>
    </span>
  )
}
