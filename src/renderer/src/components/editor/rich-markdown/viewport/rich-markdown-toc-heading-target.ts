import { splitMarkdownDocLinkText } from '../../markdown/documents/markdown-doc-links'
import {
  normalizeMarkdownTocTitle,
  type MarkdownTocItem
} from '../../markdown/navigation/markdown-table-of-contents'

// Match all TOC levels, including h4/h5, so every listed heading can resolve.
const RICH_MARKDOWN_TOC_HEADING_SELECTOR = 'h1, h2, h3, h4, h5'

// Image node views render alt text as an attribute, but the TOC title includes it.
function headingText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? ''
  }
  if (!(node instanceof Element)) {
    return ''
  }
  if (node.tagName === 'IMG') {
    return node.getAttribute('alt') ?? ''
  }
  return Array.from(node.childNodes, headingText).join('')
}

function matchingTitle(value: string): string {
  return normalizeMarkdownTocTitle(
    splitMarkdownDocLinkText(value)
      .map((part) => (part.type === 'text' ? part.value : part.label))
      .join('')
  )
}

/** Resolve every listed heading in one DOM pass, keeping duplicate-title occurrence order. */
export function resolveRichMarkdownTocHeadingTargets(
  container: ParentNode,
  items: readonly MarkdownTocItem[]
): Map<string, HTMLElement> {
  const byTitle = new Map<string, HTMLElement[]>()
  for (const candidate of container.querySelectorAll<HTMLElement>(
    RICH_MARKDOWN_TOC_HEADING_SELECTOR
  )) {
    const title = matchingTitle(headingText(candidate))
    const candidates = byTitle.get(title) ?? []
    candidates.push(candidate)
    byTitle.set(title, candidates)
  }

  const resolved = new Map<string, HTMLElement>()
  const used = new Map<string, number>()
  for (const item of items) {
    const title = matchingTitle(item.title)
    const occurrence = used.get(title) ?? 0
    used.set(title, occurrence + 1)
    const heading = byTitle.get(title)?.[occurrence]
    if (heading) {
      resolved.set(item.id, heading)
    }
  }
  return resolved
}

export function findRichMarkdownTocHeadingTarget(
  container: ParentNode,
  items: readonly MarkdownTocItem[],
  id: string
): HTMLElement | undefined {
  return resolveRichMarkdownTocHeadingTargets(container, items).get(id)
}
