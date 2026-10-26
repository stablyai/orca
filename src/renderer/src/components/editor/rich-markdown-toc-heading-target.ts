import type { MarkdownTocItem } from './markdown-table-of-contents'

// Match all TOC levels, including h4/h5, so every listed heading can resolve.
const RICH_MARKDOWN_TOC_HEADING_SELECTOR = 'h1, h2, h3, h4, h5'

export function findRichMarkdownTocHeadingTarget(
  container: ParentNode,
  items: readonly MarkdownTocItem[],
  id: string
): HTMLElement | undefined {
  const target = items.find((item) => item.id === id)
  if (!target) {
    return undefined
  }

  const sameTitleIndex = items
    .filter((item) => item.title === target.title)
    .findIndex((item) => item.id === target.id)
  let remaining = Math.max(0, sameTitleIndex)
  for (const candidate of container.querySelectorAll<HTMLElement>(
    RICH_MARKDOWN_TOC_HEADING_SELECTOR
  )) {
    if (candidate.textContent?.trim() === target.title) {
      if (remaining === 0) {
        return candidate
      }
      remaining -= 1
    }
  }
  return undefined
}
