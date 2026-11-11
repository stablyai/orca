import { useLayoutEffect } from 'react'
import type { CombinedDiffViewportOwner } from '../scroll-viewport/combined-diff-viewport-owner'
import type { CombinedDiffViewRestore } from './use-combined-diff-view-restore'
import { rememberCombinedDiffView } from './combined-diff-view-cache'

export function useCombinedDiffOwnerMemory({
  owner,
  restore,
  entrySignature,
  viewStateKey
}: {
  owner: CombinedDiffViewportOwner
  restore: CombinedDiffViewRestore
  entrySignature: string
  viewStateKey: string
}): void {
  const { memoryLeaseRef, scrollAnchorRef, scrollOffsetRef, latestDomScrollAnchorRef } = restore
  useLayoutEffect(() => {
    owner.importView(scrollAnchorRef.current, scrollOffsetRef.current)
    const lease = memoryLeaseRef.current
    const persist = (): void => {
      const anchor = owner.getAnchor()
      const scrollTop = owner.getScrollTop()
      scrollAnchorRef.current = anchor
      latestDomScrollAnchorRef.current = anchor
      scrollOffsetRef.current = scrollTop
      rememberCombinedDiffView(lease, { scrollTop, scrollAnchor: anchor ?? undefined })
    }
    const unsubscribe = owner.subscribeScroll(persist)
    return () => {
      persist()
      unsubscribe()
    }
  }, [
    entrySignature,
    latestDomScrollAnchorRef,
    memoryLeaseRef,
    owner,
    scrollAnchorRef,
    scrollOffsetRef,
    viewStateKey
  ])
}
