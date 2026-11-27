import { scrollRichMarkdownElementToContainerTop } from './rich-markdown-viewport'
import { revealMarkdownNavigationDetails } from '../../markdown/navigation/markdown-navigation-details'
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import type { MarkdownTocItem } from '../../markdown/navigation/markdown-table-of-contents'
import {
  findRichMarkdownTocHeadingTarget,
  resolveRichMarkdownTocHeadingTargets
} from './rich-markdown-toc-heading-target'
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
      const headings = resolveRichMarkdownTocHeadingTargets(container, flatTableOfContentsItems)
      let current: string | null = null
      for (const item of flatTableOfContentsItems) {
        const heading = headings.get(item.id)
        // A heading inside a closed <details> has no layout box and its rect top is 0.
        if (
          heading &&
          heading.getClientRects().length > 0 &&
          heading.getBoundingClientRect().top <= top
        ) {
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
    // Wrapping changes which heading is current without moving scrollTop (e.g. a narrower floating panel).
    const content =
      container.querySelector<HTMLElement>('.ProseMirror, .tiptap') ?? container.firstElementChild
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    if (content instanceof HTMLElement) {
      observer.observe(content)
    }
    update()
    return () => {
      container.removeEventListener('scroll', schedule)
      observer.disconnect()
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
