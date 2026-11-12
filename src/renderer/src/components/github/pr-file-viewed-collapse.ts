import { useCallback, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { DiffSection } from '@/components/editor/diff/sections/diff-section-types'

/** Marking a file Viewed collapses it and clearing expands it; a failed write undoes that. */
export function usePRFileViewedCollapse({
  sectionsRef,
  toggleSection,
  scrollContainerRef,
  pendingRestoreScrollTopRef,
  virtualizer,
  onViewedChange
}: {
  sectionsRef: RefObject<DiffSection[]>
  toggleSection: (index: number) => void
  scrollContainerRef: RefObject<HTMLDivElement | null>
  pendingRestoreScrollTopRef?: RefObject<number | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  onViewedChange: (path: string, viewed: boolean) => Promise<boolean>
}): (path: string, viewed: boolean) => Promise<void> {
  return useCallback(
    async (path, viewed) => {
      const sectionIndex = (): number =>
        sectionsRef.current.findIndex((section) => section.path === path)
      const index = sectionIndex()
      const moved = index !== -1 && sectionsRef.current[index]?.collapsed !== viewed
      if (moved) {
        // Why: a restore still catching up would jump away from the file the user is acting on.
        if (pendingRestoreScrollTopRef) {
          pendingRestoreScrollTopRef.current = null
        }
        const container = scrollContainerRef.current
        const row = virtualizer.measurementsCache[index]
        // Why: the sticky header stays clickable inside a long file; without this the next files scroll past.
        if (viewed && container && row && container.scrollTop > row.start) {
          container.scrollTop = row.start
          // Why: the virtualizer corrects later resizes from its last seen offset, which would undo this.
          container.dispatchEvent(new Event('scroll'))
        }
        toggleSection(index)
      }
      const saved = await onViewedChange(path, viewed)
      const liveIndex = sectionIndex()
      if (!saved && moved && sectionsRef.current[liveIndex]?.collapsed === viewed) {
        toggleSection(liveIndex)
      }
    },
    [
      onViewedChange,
      pendingRestoreScrollTopRef,
      scrollContainerRef,
      sectionsRef,
      toggleSection,
      virtualizer
    ]
  )
}
