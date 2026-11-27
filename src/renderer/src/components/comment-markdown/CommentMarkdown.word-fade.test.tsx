// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import CommentMarkdown from './CommentMarkdown'

afterEach(cleanup)

describe('word fade', () => {
  it('fades words in text that a plugin split off', () => {
    const view = render(
      <CommentMarkdown
        content="Fixed in #12 then more words"
        githubRepo={{ owner: 'acme', repo: 'app' }}
        growing
        fadeFrom={9}
      />
    )
    const words = Array.from(
      view.container.querySelectorAll('[data-word]'),
      (word) => word.textContent
    )
    expect(words).toEqual(['then', 'more', 'words'])
  })

  it('keeps only a held selection of earlier words as elements, and the rest plain', () => {
    const content = 'First paragraph words.\n\nSecond paragraph words.\n\nThird new words'
    const view = render(
      <CommentMarkdown
        content={content}
        growing
        fadeFrom={content.indexOf('new')}
        fadeHold={{ from: 6, to: 22 }}
      />
    )
    const words = Array.from(
      view.container.querySelectorAll('[data-word]'),
      (word) => word.textContent
    )
    expect(words).toEqual(['paragraph', 'words.', 'new', 'words'])
  })
})
