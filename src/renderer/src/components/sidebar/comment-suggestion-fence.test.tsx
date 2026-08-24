// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import CommentMarkdown from './CommentMarkdown'
import {
  CommentSuggestionBlock,
  isSuggestionFence,
  isSuggestionPre
} from './comment-suggestion-fence'

afterEach(cleanup)

describe('suggestion fence detection', () => {
  it('detects the language-suggestion class', () => {
    expect(isSuggestionFence('language-suggestion')).toBe(true)
    expect(isSuggestionFence('language-suggestions')).toBe(false)
    expect(isSuggestionFence('language-ts')).toBe(false)
    expect(isSuggestionFence(undefined)).toBe(false)
  })

  it('detects a suggestion code child for pre unwrapping', () => {
    expect(isSuggestionPre(<code className="language-suggestion">x</code>)).toBe(true)
    expect(isSuggestionPre(<code className="language-ts">x</code>)).toBe(false)
    expect(isSuggestionPre('plain text')).toBe(false)
  })
})

describe('CommentSuggestionBlock', () => {
  it('renders original and suggested lines', () => {
    render(
      <CommentSuggestionBlock
        suggestionText="const b = 2"
        options={{ originalLines: ['const a = 1'] }}
      />
    )
    expect(screen.getByText('Suggested change')).toBeInTheDocument()
    expect(screen.getByText('const a = 1')).toBeInTheDocument()
    expect(screen.getByText('const b = 2')).toBeInTheDocument()
  })

  it('labels a removal-only suggestion instead of rendering "undefined"', () => {
    render(<CommentSuggestionBlock suggestionText="" options={{ originalLines: ['gone()'] }} />)
    expect(screen.getByText('Suggestion removes these lines.')).toBeInTheDocument()
    expect(screen.queryByText('undefined')).not.toBeInTheDocument()
  })
})

describe('CommentMarkdown suggestion integration', () => {
  it('renders ```suggestion fences as diff previews in compact variant', () => {
    render(
      <CommentMarkdown
        content={'Take this:\n\n```suggestion\nconst next = 2\n```'}
        variant="compact"
        suggestion={{ originalLines: ['const prev = 1'] }}
      />
    )
    expect(screen.getByText('Suggested change')).toBeInTheDocument()
    expect(screen.getByText('const prev = 1')).toBeInTheDocument()
    expect(screen.getByText('const next = 2')).toBeInTheDocument()
  })

  it('leaves regular fences untouched', () => {
    render(
      <CommentMarkdown content={'```ts\nconst x = 1\n```'} variant="compact" suggestion={{}} />
    )
    expect(screen.queryByText('Suggested change')).not.toBeInTheDocument()
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })
})
