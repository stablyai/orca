import { useLayoutEffect, useState, type ReactNode } from 'react'

export function DeferredBrowserContent({
  mountEligible,
  retainMounted = true,
  children
}: {
  mountEligible: boolean
  retainMounted?: boolean
  children: ReactNode
}): React.JSX.Element | null {
  const [hasCommittedMount, setHasCommittedMount] = useState(false)
  // Only committed, retainable mounts may survive the loss of eligibility.
  useLayoutEffect(() => {
    if (!retainMounted) {
      setHasCommittedMount(false)
    } else if (mountEligible && !hasCommittedMount) {
      setHasCommittedMount(true)
    }
  }, [hasCommittedMount, mountEligible, retainMounted])
  return mountEligible || (retainMounted && hasCommittedMount) ? <>{children}</> : null
}
