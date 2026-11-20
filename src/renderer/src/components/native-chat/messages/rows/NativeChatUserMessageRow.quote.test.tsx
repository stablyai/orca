// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { MessageRow } from './NativeChatMessageRow'
import { quoteSourceOf } from '../../selection-quotes/native-chat-quote-highlight'
import { readNativeChatQuotableSelection } from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

afterEach(cleanup)

it('shows the quote in a sent user message as a quote chip', () => {
  render(
    <TooltipProvider>
      <MessageRow
        message={{
          id: 'sent',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: '> q\n\nreply' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>,
    { wrapper: TranslationScopeProvider }
  )
  expect(screen.getByRole('button', { name: 'Quote: q' })).not.toHaveAttribute('aria-expanded')
  expect(screen.getByText('reply')).toBeInTheDocument()
})

it("offers the user's own sent words to Add to chat, with the message as the source", () => {
  const { container } = render(
    <TooltipProvider>
      <MessageRow
        message={{
          id: 'mine',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'my own words' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>,
    { wrapper: TranslationScopeProvider }
  )
  const words = screen.getByText('my own words').firstChild!
  const range = document.createRange()
  range.setStart(words, 3)
  range.setEnd(words, 6)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  const quotable = readNativeChatQuotableSelection(container)
  expect(quotable?.text).toBe('own')
  expect(quoteSourceOf(quotable!.sourceElement, quotable!.range)).toMatchObject({
    messageId: 'mine',
    place: { offset: 3, length: 3 }
  })
})
