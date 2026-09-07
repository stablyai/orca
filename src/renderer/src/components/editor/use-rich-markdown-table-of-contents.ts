import { useCallback, useMemo, type MutableRefObject } from 'react'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import { findRichMarkdownTocHeadingTarget } from './rich-markdown-toc-heading-target'
import { selectMarkdownTableOfContents } from './markdown-toc-visibility-gate'

function flattenMarkdownTocItems(items: MarkdownTocItem[]): MarkdownTocItem[] {
  return items.flatMap((item) => [item, ...flattenMarkdownTocItems(item.children)])
}

export function useRichMarkdownTableOfContents(
  showTableOfContents: boolean,
  content: string,
  scrollContainerRef: MutableRefObject<HTMLElement | null>
): {
  tableOfContentsItems: MarkdownTocItem[]
  navigateToTableOfContentsItem: (id: string) => void
} {
  // Why: building the table of contents runs a full-document remark parse on
  // every content change. The result is only used while the panel is open
  // (closed by default), so gate the parse on visibility; including
  // showTableOfContents in deps rebuilds the outline the moment it opens.
  const tableOfContentsItems = useMemo(
    () => selectMarkdownTableOfContents(showTableOfContents, content),
    [content, showTableOfContents]
  )
  const flatTableOfContentsItems = useMemo(
    () => flattenMarkdownTocItems(tableOfContentsItems),
    [tableOfContentsItems]
  )

  const navigateToTableOfContentsItem = useCallback(
    (id: string): void => {
      const container = scrollContainerRef.current
      if (!container) {
        return
      }
      const heading = findRichMarkdownTocHeadingTarget(container, flatTableOfContentsItems, id)
      heading?.scrollIntoView({ block: 'center' })
    },
    [flatTableOfContentsItems, scrollContainerRef]
  )

  return { tableOfContentsItems, navigateToTableOfContentsItem }
}
