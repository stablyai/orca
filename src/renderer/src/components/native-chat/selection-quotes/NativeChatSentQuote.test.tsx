// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { formatNativeChatQuote } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

afterEach(cleanup)

function sent(content: string) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatMarkdown content={content} variant="document" quoteChips />
    </TooltipProvider>
  )
}

it('shows a sent quote as a chip named by its text, with no action', () => {
  sent(`my words\n\n${formatNativeChatQuote('the quoted words')}reply`)
  const chip = document.querySelector('[data-native-chat-sent-quote]')!
  // One spoken phrase: the shown text is not read a second time.
  expect(chip.querySelector('.sr-only')).toHaveTextContent(/^Quote: the quoted words$/)
  expect(chip.querySelector('.truncate')).toHaveAttribute('aria-hidden', 'true')
  expect(chip.tagName).not.toBe('BUTTON')
  expect(screen.queryByRole('button')).toBeNull()
})

// Markdown reads "- removed" as a list: the chip's tooltip shows the quoted text as it was taken.
it('shows the quoted text with its Markdown marks in the tooltip', async () => {
  sent(`${formatNativeChatQuote('- removed')}reply`)
  fireEvent.focus(document.querySelector('[data-native-chat-sent-quote]')!)
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/^- removed$/)
})

it('keeps blockquotes as text where quote chips are off', () => {
  render(<NativeChatMarkdown content="> quoted" variant="document" />)
  expect(document.querySelector('[data-native-chat-sent-quote]')).toBeNull()
  expect(document.querySelector('blockquote')).toHaveTextContent('quoted')
})
