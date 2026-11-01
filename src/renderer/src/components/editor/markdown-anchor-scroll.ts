import { revealMarkdownNavigationDetails } from './markdown-navigation-details'
import { MarkdownHeadingSlugger } from './markdown-heading-slug'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import { settleMermaidNavigation } from './use-mermaid-viewport'

// Match preview suffixes for duplicate headings so anchors resolve to the same heading.
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
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  const slugger = new MarkdownHeadingSlugger()
  for (const heading of headings) {
    if (slugger.slug(heading.textContent ?? '') === decoded) {
      revealMarkdownNavigationDetails(heading)
      const container = heading.closest<HTMLElement>('.overflow-auto')
      const pending = container
        ? settleMermaidNavigation(
            container,
            () => {
              if (root.contains(heading)) {
                heading.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: 'start' })
              }
            },
            heading
          )
        : undefined
      heading.scrollIntoView({
        behavior: pending ? 'instant' : motionSafeScrollBehavior(),
        block: 'start'
      })
      return
    }
  }
}
