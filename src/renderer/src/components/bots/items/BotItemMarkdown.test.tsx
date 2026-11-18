// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatFileLinkExistenceContext } from '../../native-chat/links/actions/native-chat-file-link-existence'
import { NativeChatLinkClickContext } from '../../native-chat/links/actions/native-chat-link-click-context'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { BotItemMarkdown } from './BotItemMarkdown'

afterEach(cleanup)

const exists = {
  check: (link: { pathText: string }) => link.pathText === '/Users/x/orca-lanes/lead/report.md',
  peek: () => false
}
const existence = {
  watch: () => ({ subscribe: () => () => {}, getSnapshot: () => exists }),
  recheck: () => {}
}

it('links a file path in a comment and opens it through the chat link handler', () => {
  const opened = vi.fn<CommentMarkdownLinkClickHandler>((event) => event.preventDefault())
  render(
    <NativeChatFileLinkExistenceContext value={existence}>
      <NativeChatLinkClickContext value={opened}>
        <BotItemMarkdown text="Report is at /Users/x/orca-lanes/lead/report.md now." />
      </NativeChatLinkClickContext>
    </NativeChatFileLinkExistenceContext>
  )

  fireEvent.click(screen.getByRole('link', { name: '/Users/x/orca-lanes/lead/report.md' }))

  expect(opened).toHaveBeenCalledOnce()
  expect(opened.mock.calls[0][1]).toBe(
    '#orca-native-chat-file=%2FUsers%2Fx%2Forca-lanes%2Flead%2Freport.md'
  )
})
