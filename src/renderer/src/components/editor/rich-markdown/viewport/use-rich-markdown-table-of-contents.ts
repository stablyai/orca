import { scrollRichMarkdownElementToContainerTop } from './rich-markdown-viewport'
import { revealMarkdownNavigationDetails } from '../../markdown/navigation/markdown-navigation-details'
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import type { MarkdownTocItem } from '../../markdown/navigation/markdown-table-of-contents'
import { findRichMarkdownTocHeadingTarget } from './rich-markdown-toc-heading-target'
import { selectMarkdownTableOfContents } from '../../markdown/navigation/markdown-toc-visibility-gate'

function flattenMarkdownTocItems(items: MarkdownTocItem[]): MarkdownTocItem[] {
  return items.flatMap((item) => [item, ...flattenMarkdownTocItems(item.children)])
}

export function useRichMarkdownTableOfContents(
  showTableOfContents: boolean,
  content: string,
  scrollContainerRef: MutableRefObject<HTMLElement | null>
): {
  tableOfContentsItems: MarkdownTocItem[]
  activeTocId: string | null
  navigateToTableOfContentsItem: (id: string) => void
} {
  const tableOfContentsItems = useMemo(
    () => selectMarkdownTableOfContents(showTableOfContents, content),
    [content, showTableOfContents]
  )
  const flatTableOfContentsItems = useMemo(
    () => flattenMarkdownTocItems(tableOfContentsItems),
    [tableOfContentsItems]
  )

  const [activeTocId, setActiveTocId] = useState<string | null>(null)

  // Keep the outline's current row in step with what the reader is looking at, including a TOC jump.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !showTableOfContents) {
      setActiveTocId(null)
      return
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const top = container.getBoundingClientRect().top + 16
      let current: string | null = null
      for (const item of flatTableOfContentsItems) {
        const heading = findRichMarkdownTocHeadingTarget(
          container,
          flatTableOfContentsItems,
          item.id
        )
        if (heading && heading.getBoundingClientRect().top <= top) {
          current = item.id
        }
      }
      setActiveTocId(current)
    }
    const schedule = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(update)
      }
    }
    container.addEventListener('scroll', schedule, { passive: true })
    update()
    return () => {
      container.removeEventListener('scroll', schedule)
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [flatTableOfContentsItems, scrollContainerRef, showTableOfContents])

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      const container = scrollContainerRef.current
      if (!container) {
        return
      }
      const heading = findRichMarkdownTocHeadingTarget(container, flatTableOfContentsItems, id)
      if (heading) {
        revealMarkdownNavigationDetails(heading)
        scrollRichMarkdownElementToContainerTop(heading, container)
      }
    },
    [flatTableOfContentsItems, scrollContainerRef]
  )

  return { tableOfContentsItems, activeTocId, navigateToTableOfContentsItem }
}
