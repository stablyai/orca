// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { routeNativeChatHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { NativeChatLinkClickContext } from '../links/actions/native-chat-link-click-context'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const opened = vi.fn()
const onLinkClick: CommentMarkdownLinkClickHandler = (event, href) => {
  event.preventDefault()
  opened(routeNativeChatHref(href))
}

afterEach(() => {
  cleanup()
  opened.mockClear()
})

it('preserves a literal Codex path and repairs surrounding Markdown during streaming', () => {
  const path = '/tmp/Задачи/Отчёт [Q4 #1%.docx'
  const citation = `:codex-file-citation{path="${path}" purpose="output"}`
  render(
    <NativeChatLinkClickContext.Provider value={onLinkClick}>
      <NativeChatMarkdown
        content={`Готово.\n\n\`${citation}\`\n\n${citation} **Ready`}
        streaming
        variant="document"
      />
    </NativeChatLinkClickContext.Provider>
  )

  fireEvent.click(screen.getByRole('link', { name: 'Отчёт [Q4 #1%.docx' }))
  expect(opened).toHaveBeenCalledWith({
    kind: 'file',
    pathText: path,
    line: null,
    pathKind: 'literal'
  })
  expect(screen.getByText(citation).tagName).toBe('CODE')
  expect(screen.getByText('Ready').tagName).toBe('STRONG')
})
