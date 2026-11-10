import { buildMarkdownTableOfContents, type MarkdownTocItem } from './markdown-table-of-contents'

// Keep hidden TOC results referentially stable to avoid downstream rerenders.
const EMPTY_MARKDOWN_TOC: MarkdownTocItem[] = []

/** Skip the full-document parse while the TOC is hidden, including on content changes. */
export function selectMarkdownTableOfContents(
  showTableOfContents: boolean,
  content: string,
  build: (markdown: string) => MarkdownTocItem[] = buildMarkdownTableOfContents
): MarkdownTocItem[] {
  return showTableOfContents ? build(content) : EMPTY_MARKDOWN_TOC
}
