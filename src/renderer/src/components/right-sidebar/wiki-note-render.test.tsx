// @vitest-environment happy-dom
// Regression: the REAL CommentMarkdown must hide frontmatter and render a converted
// [[wikilink]] as a clickable anchor that fires onLinkClick with the resolved href.
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { prepareWikiNoteForDisplay } from './wiki-note-content'

afterEach(() => cleanup())

const RAW =
  '---\ntags:\n  - type/moc\nemoji: 📦\n---\n\n# Home Overview\n\nGo to [[TargetNote]] for details.\n'

describe('wiki note rendered by the real CommentMarkdown', () => {
  it('hides frontmatter tags', () => {
    render(
      <CommentMarkdown
        variant="document"
        content={prepareWikiNoteForDisplay(RAW)}
        onLinkClick={() => {}}
      />
    )
    expect(screen.queryByText(/type\/moc/)).toBeNull()
    expect(screen.getByText(/Home Overview/)).toBeInTheDocument()
  })

  it('renders a wikilink as a clickable anchor that fires onLinkClick with the target href', async () => {
    // Prevent happy-dom from following the anchor navigation on click.
    const onLinkClick = vi.fn((event: { preventDefault?: () => void }, _href?: string) =>
      event?.preventDefault?.()
    )
    render(
      <CommentMarkdown
        variant="document"
        content={prepareWikiNoteForDisplay(RAW)}
        onLinkClick={onLinkClick}
      />
    )
    const link = screen.getByRole('link', { name: /TargetNote/i })
    expect(link).toBeInTheDocument()
    link.click()
    expect(onLinkClick).toHaveBeenCalled()
    const href = onLinkClick.mock.calls[0][1]
    expect(href).toMatch(/TargetNote/)
  })
})
