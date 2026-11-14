// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import CommentMarkdown, { type CommentMarkdownExtension } from './CommentMarkdown'

import { NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER } from '../../../../shared/native-chat/native-chat-visual-directive'
import { remarkNativeChatVisuals } from '../native-chat/media/visuals/native-chat-visual-markdown-syntax'
vi.mock('../native-chat/media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: ({ file }: { file: string }) => <div data-visual-file={file} />
}))
vi.mock('../native-chat/links/actions/use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const code = ({ children, sourceLine }: { children?: React.ReactNode; sourceLine?: number }) => (
  <pre data-source-line={sourceLine}>{children}</pre>
)

const directive = (i = 0) => `::orca-visual{file="v${i}.html"}`
const prefix = '```text\nsettled\n```\n\nNext'

it('keeps selected fade nodes and their clocks through a declined tail and completion', () => {
  vi.useFakeTimers()
  const extension: CommentMarkdownExtension = {
    remarkPlugins: [[remarkNativeChatVisuals, 'n']],
    extraFlowSyntaxMarkers: [NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER],
    sanitizeAttributes: {},
    components: {}
  }
  const view = render(
    <CommentMarkdown
      content={`${prefix}\n\nselected words`}
      growing
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  const fence = view.container.querySelector('pre')
  const word = [...view.container.querySelectorAll('[data-word]')].find(
    (node) => node.textContent === 'selected'
  )!
  const range = document.createRange()
  range.selectNodeContents(word)
  document.getSelection()?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(150))
  const content = `${prefix}\n\nselected words\n\n${directive()}\n\nnew words`
  view.rerender(
    <CommentMarkdown
      content={content}
      growing
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  expect(view.container.querySelector('pre')).toBe(fence)
  expect(word.isConnected).toBe(true)
  act(() => vi.advanceTimersByTime(150))
  expect(word.isConnected).toBe(true)
  expect(
    [...view.container.querySelectorAll('[data-word]')].some((node) => node.textContent === 'new')
  ).toBe(true)
  view.rerender(
    <CommentMarkdown
      content={content}
      fadeWords
      extension={extension}
      variant="document"
      renderCodeBlock={code}
    />
  )
  expect(document.getSelection()?.toString()).toBe('selected')
  document.getSelection()?.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  act(() => vi.advanceTimersByTime(1))
  expect(word.isConnected).toBe(false)
})
