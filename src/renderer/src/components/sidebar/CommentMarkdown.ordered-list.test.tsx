// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from '@/components/native-chat/NativeChatMessageRow'
import CommentMarkdown from './CommentMarkdown'

afterEach(cleanup)

describe.each(['compact', 'document'] as const)('%s markdown ordered lists', (variant) => {
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
