import { useEffect, useState, type ReactNode } from 'react'
import { LoadingSpinner } from '@/components/LoadingSpinner'

/** Deferred so a fast local round-trip never flashes a spinner; the button greys at once. */
const PENDING_SPINNER_DELAY_MS = 200

/** A button's icon that turns into the working spinner while its own action is on its way. The
 *  spinner takes the icon's size, so the button never resizes mid-action. */
export function NativeChatPendingIcon({
  pending,
  className,
  children
}: {
  pending: boolean
  /** The icon's size classes, given to the spinner too. */
  className: string
  children: ReactNode
}): React.JSX.Element {
  const [showSpinner, setShowSpinner] = useState(false)
  useEffect(() => {
    if (!pending) {
      setShowSpinner(false)
      return
    }
    const timer = setTimeout(() => setShowSpinner(true), PENDING_SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending])
  return showSpinner ? <LoadingSpinner className={className} /> : <>{children}</>
}
