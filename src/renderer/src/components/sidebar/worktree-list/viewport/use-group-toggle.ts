import { useCallback, useMemo } from 'react'
import type React from 'react'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import { createLineageToggleHandlerCache } from '../../worktree-lineage-toggle-handler-cache'

// Collapsing a section changes total height, so snapshot the anchor first or the viewport jumps.
export function useGroupToggleWithScrollAnchor(args: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  toggleGroup: (key: string) => void
}) {
  const { scrollRef, toggleGroup } = args
  const recordCurrentScrollAnchor = useCallback(() => {
    scrollRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  }, [scrollRef])
  const toggleGroupWithScrollAnchor = useCallback(
    (groupKey: string) => {
      recordCurrentScrollAnchor()
      toggleGroup(groupKey)
    },
    [recordCurrentScrollAnchor, toggleGroup]
  )
  // Why: memo'd WorktreeCard needs a per-group-key stable onLineageToggle
  // identity to bail out of re-renders; see worktree-lineage-toggle-handler-cache.
  const getLineageToggleHandler = useMemo(
    () => createLineageToggleHandlerCache(toggleGroupWithScrollAnchor),
    [toggleGroupWithScrollAnchor]
  )

  return { toggleGroupWithScrollAnchor, getLineageToggleHandler }
}
