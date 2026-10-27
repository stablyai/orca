import { useEffect, useState, type ReactNode } from 'react'
import { LoadingSpinner } from '@/components/LoadingSpinner'

/** Deferred so a fast local round-trip never flashes a spinner; the button greys at once. */
const PENDING_SPINNER_DELAY_MS = 200

/** Reuse the icon’s size for the delayed spinner so pending actions cannot resize the button. */
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
