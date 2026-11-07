// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const mocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('./CommentMermaidBlock', () => ({ default: mocks.mermaid }))

afterEach(() => {
  cleanup()
  expect(mocks.mermaid).not.toHaveBeenCalled()
  mocks.mermaid.mockClear()
})

describe('growing comment markdown', () => {
  it('links a path in an earlier block once the host confirms it', () => {
    const content = 'Edited src/a.ts.\n\nThen more text'
    const view = render(
      <CommentMarkdown content={content} variant="document" fileLinkExists={() => false} growing />
    )
    expect(view.container.querySelector('a')).toBeNull()

    view.rerender(
      <CommentMarkdown content={content} variant="document" fileLinkExists={() => true} />
    )

    expect(view.container.querySelector('a')?.textContent).toBe('src/a.ts')
  })
})
