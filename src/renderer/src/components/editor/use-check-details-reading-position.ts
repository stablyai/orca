import { useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { checkReadingOuterKey } from './check-details-reading-cache'
import { createCheckDetailsReadingOwner } from './check-details-reading-owner'
import { attachCheckReadingViewport } from './check-details-reading-viewport'

export function useCheckDetailsReadingPosition(tabId?: string, scope?: string, context?: string) {
  const ref = useRef<HTMLDivElement>(null)
  const owner = useMemo(
    () =>
      tabId && scope && context
        ? createCheckDetailsReadingOwner(useAppStore, tabId, scope, context)
        : undefined,
    [tabId, scope, context]
  )
  useLayoutEffect(() => owner?.attach(), [owner])
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !owner) {
      return
    }
    return attachCheckReadingViewport({ node, owner, cacheKey: checkReadingOuterKey(owner.key) })
  }, [owner])
  return { ref, owner }
}
