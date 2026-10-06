// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

describe('chat markdown isolation', () => {
  it('opts chat into appearance styles without applying them to ordinary comments', () => {
    render(
      <>
        <NativeChatMarkdown content="Chat message" className="text-sm" data-testid="chat" />
        <CommentMarkdown content="Sidebar comment" data-testid="comment" />
      </>
    )

    expect(screen.getByTestId('chat')).toHaveClass('native-chat-markdown', 'text-sm')
    expect(screen.getByTestId('comment')).not.toHaveClass('native-chat-markdown')
    expect(screen.getByText('Chat message')).toBeInTheDocument()
    expect(screen.getByText('Sidebar comment')).toBeInTheDocument()
  })

  it('scopes word-boundary link wrapping to chat links', () => {
    render(
      <>
        <NativeChatMarkdown
          content="See [AppearancePane.tsx](https://example.com/chat)"
          variant="document"
        />
        <CommentMarkdown
          content="See [SidebarPane.tsx](https://example.com/comment)"
          variant="document"
        />
      </>
    )

    expect(
      screen.getByRole('link', { name: 'AppearancePane.tsx' }).matches('.native-chat-markdown a')
    ).toBe(true)
    expect(
      screen.getByRole('link', { name: 'SidebarPane.tsx' }).matches('.native-chat-markdown a')
    ).toBe(false)
  })
})
