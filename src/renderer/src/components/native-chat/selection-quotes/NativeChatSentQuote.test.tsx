// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => ({ open: vi.fn(), toast: vi.fn() }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))
vi.mock('@/components/terminal-pane/links/files/terminal-file-open-routing', () => ({
  openDetectedFilePath: opened.open
}))
vi.mock('sonner', () => ({ toast: opened.toast }))

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

it('shows a notice when the quote has no known source', () => {
  sent('> typed by hand\n\nreply')
  fireEvent.click(screen.getByRole('button', { name: 'Quote: typed by hand' }))
  expect(opened.toast).toHaveBeenCalledOnce()
  expect(opened.open).not.toHaveBeenCalled()
})

// Markdown reads "- removed" as a list: the chip's tooltip shows the quoted text as it was taken.
it('shows the quoted text with its Markdown marks in the tooltip', async () => {
  sent(`${formatNativeChatQuote('- removed')}reply`)
  fireEvent.focus(screen.getByRole('button', { name: /^Quote: / }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/^- removed$/)
})
