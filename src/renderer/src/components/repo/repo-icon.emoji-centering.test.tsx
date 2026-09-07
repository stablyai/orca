// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoIconGlyph } from './repo-icon'

afterEach(() => {
  cleanup()
})

// Every RepoIconGlyph call site passes a fixed `size-*` in iconClassName, so the
// span carrying it is a sized box holding a bare text node. The image branch
// (`size-full object-contain`) and the lucide branch (the svg fills its own box)
// centre structurally; only the emoji branch has to ask for it.
describe('RepoIconGlyph emoji centering', () => {
  it('centers the glyph inside the box iconClassName sizes', () => {
    const { container } = render(
      <RepoIconGlyph
        repoIcon={{ type: 'emoji', emoji: '🐙' }}
        className="size-10"
        iconClassName="size-5"
      />
    )

    const glyphBox = container.querySelector('.size-5')
    expect(glyphBox?.textContent).toBe('🐙')
    expect(glyphBox?.className).toContain('inline-flex')
    expect(glyphBox?.className).toContain('items-center')
    expect(glyphBox?.className).toContain('justify-center')
  })

  it('renders the glyph as the only child so justify-center has one flex item', () => {
    const { container } = render(
      <RepoIconGlyph repoIcon={{ type: 'emoji', emoji: '🐙' }} iconClassName="size-5" />
    )

    // Stray JSX whitespace would become a second anonymous flex item and shift the glyph.
    expect(container.querySelector('.size-5')?.childNodes).toHaveLength(1)
  })
})
