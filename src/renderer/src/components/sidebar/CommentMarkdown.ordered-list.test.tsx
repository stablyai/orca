// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from '@/components/native-chat/NativeChatMessageRow'
import CommentMarkdown from './CommentMarkdown'

afterEach(cleanup)

describe.each(['compact', 'document'] as const)('%s markdown ordered lists', (variant) => {
  it.each([0, 3, 42])('preserves a starting number of %i', (start) => {
    render(<CommentMarkdown variant={variant} content={`${start}. First\n${start + 1}. Second`} />)

    expect(screen.getByRole('list')).toHaveAttribute('start', String(start))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('preserves the start with a custom link handler', () => {
    render(
      <CommentMarkdown variant={variant} content={'3. Third\n4. Fourth'} onLinkClick={vi.fn()} />
    )

    expect(screen.getByRole('list')).toHaveAttribute('start', '3')
  })

  it('preserves independent starts for nested lists', () => {
    render(
      <CommentMarkdown
        variant={variant}
        content={'3. Third\n\n   7. Seventh\n   8. Eighth\n\n4. Fourth'}
      />
    )

    expect(screen.getAllByRole('list').map((list) => list.getAttribute('start'))).toEqual([
      '3',
      '7'
    ])
  })

  it('preserves independent starts for lists separated by a paragraph', () => {
    render(
      <CommentMarkdown
        variant={variant}
        content={'3. Third\n4. Fourth\n\nContinue below.\n\n9. Ninth\n10. Tenth'}
      />
    )

    expect(screen.getAllByRole('list').map((list) => list.getAttribute('start'))).toEqual([
      '3',
      '9'
    ])
  })

  it('keeps the default start when the source starts at one', () => {
    render(<CommentMarkdown variant={variant} content={'1. First\n2. Second'} />)

    expect(screen.getByRole('list').tagName).toBe('OL')
    expect(screen.getByRole('list')).not.toHaveAttribute('start')
  })

  it('keeps bullet lists unordered', () => {
    render(<CommentMarkdown variant={variant} content={'- First\n- Second'} />)

    expect(screen.getByRole('list').tagName).toBe('UL')
    expect(screen.getByRole('list')).not.toHaveAttribute('start')
  })
})

it.each(['user', 'assistant'] as const)('preserves the start in a %s chat message', (role) => {
  render(
    <MessageRow
      message={{
        id: 'ordered-list-message',
        role,
        timestamp: null,
        source: 'transcript',
        blocks: [{ type: 'text', text: '3. Third\n4. Fourth' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
    />
  )

  expect(screen.getByRole('list')).toHaveAttribute('start', '3')
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'Third',
    'Fourth'
  ])
})
