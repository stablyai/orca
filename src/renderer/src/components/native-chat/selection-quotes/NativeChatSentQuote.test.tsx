// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as LinkOpenRequest from '@/lib/links/link-open-request'

const opened = vi.hoisted(() => ({ open: vi.fn(), toast: vi.fn(), editor: vi.fn() }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))
vi.mock('@/components/terminal-pane/links/files/terminal-file-open-routing', () => ({
  openDetectedFilePath: opened.open
}))
vi.mock('@/components/terminal-pane/links/files/terminal-file-link-editor-open', () => ({
  openLinkedFileInEditor: opened.editor
}))
vi.mock('sonner', () => ({ toast: opened.toast }))
// Counts the link-open turns that a click takes.
const turns = vi.hoisted(() => ({ begun: 0 }))
vi.mock('@/lib/links/link-open-request', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkOpenRequest>()
  return {
    ...actual,
    beginLinkOpenRequest: () => {
      turns.begun += 1
      return actual.beginLinkOpenRequest()
    }
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatMarkdownImageOwnerContext } from '../media/images/native-chat-markdown-image-owner'
import { NativeChatQuoteJumpContext, type NativeChatQuoteJump } from './use-native-chat-quote-jump'
import { formatNativeChatQuote } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { rememberNativeChatQuoteSource } from './native-chat-quote-sources'

afterEach(() => {
  cleanup()
  localStorage.clear()
  opened.open.mockReset()
  opened.toast.mockReset()
  opened.editor.mockReset()
})

const OWNER = {
  fileLinkContext: { worktreeId: 'w1', worktreePath: '/repo', runtimeEnvironmentId: null },
  runtimeContext: null,
  isVisible: true
}

function sent(content: string, jump: NativeChatQuoteJump = () => true) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatMarkdownImageOwnerContext.Provider value={OWNER}>
        <NativeChatQuoteJumpContext.Provider value={jump}>
          <NativeChatMarkdown content={content} variant="document" quoteChips />
        </NativeChatQuoteJumpContext.Provider>
      </NativeChatMarkdownImageOwnerContext.Provider>
    </TooltipProvider>
  )
}

// Each quote, as "Add to chat" took it from a reply, and as the user sends it after their own text.
it.each(['use <div className="x">hello</div> there', '- removed', '```ts\nconst a = 1\n```'])(
  'jumps from the sent quote of %j to its message',
  (quote) => {
    const place = { offset: 2, length: 5, hash: 'h' }
    rememberNativeChatQuoteSource(quote, { messageId: 'reply-2', place })
    const jump = vi.fn(() => true)
    sent(`my words\n\n${formatNativeChatQuote(quote)}reply`, jump)
    fireEvent.click(screen.getByRole('button', { name: /^Quote: / }))
    expect(jump).toHaveBeenCalledWith(
      { messageId: 'reply-2', place },
      quote,
      expect.any(Function),
      expect.any(Function)
    )
    expect(opened.toast).not.toHaveBeenCalled()
  }
)

it('opens the quoted file at its first line and highlights that line', () => {
  sent('> src/a.ts:12-14\n> ```ts\n> const a = 1\n> ```\n\nreply')
  fireEvent.click(screen.getByRole('button', { name: /^Quote: src\/a\.ts:12-14/ }))
  expect(opened.open).toHaveBeenCalledWith(
    '/repo/src/a.ts',
    12,
    1,
    expect.objectContaining({ worktreeId: 'w1', revealLength: Number.MAX_SAFE_INTEGER })
  )
  expect(opened.toast).not.toHaveBeenCalled()
})

// The page of an HTML file has no lines: a quote of its source opens the code at the quoted line.
it('opens a quoted HTML file in the editor at its first line', () => {
  sent('> site/index.html:7-9\n> ```html\n> <p>hi</p>\n> ```\n\nreply')
  turns.begun = 0
  fireEvent.click(screen.getByRole('button', { name: /^Quote: site\/index\.html:7-9/ }))
  expect(opened.editor).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/repo/site/index.html', relativePath: 'site/index.html' }),
    null,
    { line: 7, column: 1, length: Number.MAX_SAFE_INTEGER },
    expect.any(Function)
  )
  expect(opened.open).not.toHaveBeenCalled()
  expect(opened.toast).not.toHaveBeenCalled()
  // The open uses the click's turn; a second turn would make the click's own steps stale.
  expect(turns.begun).toBe(1)
})

// A typed or pasted quote is a chip too; it has nowhere to go, so a click shows no error.
it('shows no notice when the quote has no known source', () => {
  sent('> typed by hand\n\nreply')
  fireEvent.click(screen.getByRole('button', { name: 'Quote: typed by hand' }))
  expect(opened.toast).not.toHaveBeenCalled()
  expect(opened.open).not.toHaveBeenCalled()
})

// Markdown reads "- removed" as a list: the chip's tooltip shows the quoted text as it was taken.
it('shows the quoted text with its Markdown marks in the tooltip', async () => {
  sent(`${formatNativeChatQuote('- removed')}reply`)
  fireEvent.focus(screen.getByRole('button', { name: /^Quote: / }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/^- removed$/)
})
