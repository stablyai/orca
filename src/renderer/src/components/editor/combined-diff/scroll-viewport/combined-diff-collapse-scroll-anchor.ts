import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'

type CollapsibleSection = {
  collapsed: boolean
  key: string
}

/**
 * Collapsing the section the viewport is inside drops that section's body.
 * The recorded offset still points into the body, so restore lands on later
 * sections. Pin the header (offset 0) and leave scrollTop alone: restore
 * treats a matching scrollTop as "the user has not moved" and then applies
 * the offset. Expanding, or collapsing some other section, keeps the anchor
 * so a later section stays where it was.
 */
export function pinScrollAnchorWhenCollapsingSection(
  anchor: VirtualizedScrollAnchor,
  section: CollapsibleSection | undefined
): void {
  if (!anchor || !section || section.collapsed || anchor.key !== section.key) {
    return
  }
  anchor.offset = 0
}

export function planCombinedDiffSectionToggle<T extends CollapsibleSection>(input: {
  index: number
  sections: readonly T[]
  anchor: VirtualizedScrollAnchor
}): {
  next: (sections: readonly T[]) => T[]
  shouldLoadAfterExpand: boolean
} {
  const section = input.sections[input.index]
  const shouldLoadAfterExpand = section?.collapsed ?? false
  pinScrollAnchorWhenCollapsingSection(input.anchor, section)
  return {
    shouldLoadAfterExpand,
    next: (sections) =>
      sections.map((row, index) =>
        index === input.index ? { ...row, collapsed: !row.collapsed } : row
      )
  }
}
