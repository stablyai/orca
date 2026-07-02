import type { MarkdownTocItem } from './markdown-table-of-contents'

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
  const matchingHeadings = Array.from(
    container.querySelectorAll<HTMLElement>(RICH_MARKDOWN_TOC_HEADING_SELECTOR)
  ).filter((candidate) => candidate.textContent?.trim() === target.title)

  return matchingHeadings.at(Math.max(0, sameTitleIndex))
}
