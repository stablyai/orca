import GithubSlugger from 'github-slugger'

// Why: rehype-slug generates heading ids using a stateful GithubSlugger that
// appends numeric suffixes to duplicate headings (foo, foo-1, foo-2). To keep
// the editor's anchor matching in parity with the preview, we must use the
// same stateful slugger — the stateless `slug()` helper would miss suffixes
// and silently land on the wrong heading.
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
  const slugger = new GithubSlugger()
  for (const heading of headings) {
    if (slugger.slug(heading.textContent ?? '') === decoded) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
  }
}
