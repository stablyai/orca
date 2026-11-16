import { useCallback, useMemo } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import {
  mergeManualTagOrder,
  normalizeManualTagOrder
} from '../../../../../../shared/worktree/metadata/manual-tag-order'
import { useOrderedHeaderDrag } from './ordered-header-drag'
import { isTagHeaderActionTarget, readTagHeaderRects } from './tag-header-drag-dom'

/** Drag-to-reorder for tag section headers, active only in Tag mode with the manual tag order. */
export function useTagHeaderDrag(args: {
  rows: HostSectionRow[]
  groupBy: WorktreeGroupBy
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScrollIntent: () => void
}) {
  const { rows, groupBy, scrollRef, onScrollIntent } = args
  const tagOrderBy = useAppStore((s) => s.tagOrderBy)
  // Why labels, not group keys: the persisted order stores tag spellings, and
  // Untagged is a catch-all lane that must stay pinned last.
  const tagHeaderLabels = useMemo(
    () =>
      rows.flatMap((row) =>
        row.type === 'header' && row.icon.kind === 'tag' && row.label ? [row.label] : []
      ),
    [rows]
  )
  const orderedTagLabels = useMemo(
    () => normalizeManualTagOrder(tagHeaderLabels),
    [tagHeaderLabels]
  )
  // Why: host sections repeat one tag's header under every host holding it, so a
  // dragged header has no single position to move. Order still applies; only the
  // drag rests until the sidebar shows one header per tag again.
  const hasDuplicateTagHeaders = orderedTagLabels.length !== tagHeaderLabels.length
  const canReorderTagHeaders =
    groupBy === 'tag' && tagOrderBy === 'manual' && !hasDuplicateTagHeaders
  const commitTagOrder = useCallback(
    (orderedTags: string[]) => {
      onScrollIntent()
      const { manualTagOrder, setManualTagOrder } = useAppStore.getState()
      setManualTagOrder(mergeManualTagOrder(manualTagOrder, orderedTags))
    },
    [onScrollIntent]
  )
  // Drag applies only in manual order; still construct the controller inert for stable hook order.
  const tagDrag = useOrderedHeaderDrag({
    orderedIds: canReorderTagHeaders ? orderedTagLabels : [],
    onCommit: commitTagOrder,
    getScrollContainer: () => scrollRef.current,
    readHeaderRects: readTagHeaderRects,
    isActionTarget: isTagHeaderActionTarget,
    // Why: tag sections are virtualized and user-created, so only some are mounted.
    requireAllHeaderRects: false
  })
  return { canReorderTagHeaders, tagDrag }
}
