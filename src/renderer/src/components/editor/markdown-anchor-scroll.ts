import { MarkdownHeadingSlugger } from './markdown-heading-slug'

// Why: duplicate headings need the same stateful suffixes as the preview
// renderer (foo, foo-1, foo-2) or anchor links can jump to the wrong heading.
export function scrollToAnchorInEditor(root: HTMLElement | null, anchor: string): void {
  if (!root || !anchor) {
    return
  }
  let decoded = anchor
  try {
    decoded = decodeURIComponent(anchor)
  } catch {
    // Malformed %-escapes: fall back to the raw fragment.
  }
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
  const slugger = new MarkdownHeadingSlugger()
  for (const heading of headings) {
    if (slugger.slug(heading.textContent ?? '') === decoded) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
  }
}
