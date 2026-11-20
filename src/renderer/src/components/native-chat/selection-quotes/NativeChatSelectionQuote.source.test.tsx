// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as I18n from '@/i18n/i18n'
import type { NativeChatComposerHandle } from '../composer/native-chat-composer-types'
import { NativeChatSelectionQuote } from './NativeChatSelectionQuote'
import { nativeChatQuoteSourceProps } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { nativeChatQuoteSource } from './native-chat-quote-sources'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

const appendText = vi.fn<(text: string) => void>()
const composer: NativeChatComposerHandle = {
  focus: () => true,
  insertAgentReferences: () => false,
  insertTypedText: () => true,
  appendText,
  acceptsText: () => true,
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false
}

function Chat(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef}>
      <div data-native-chat-scroll="">
        <div {...nativeChatQuoteSourceProps('reply-1')}>
          <pre data-testid="reply">{'Use the draft store.\n\nIt already appends.'}</pre>
        </div>
      </div>
      <NativeChatSelectionQuote rootRef={rootRef} composerRef={{ current: composer }} enabled />
    </div>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  appendText.mockClear()
  vi.useRealTimers()
})

it('adds the quote and remembers the message it came from', () => {
  render(<Chat />)
  const reply = screen.getByTestId('reply')
  fireEvent.pointerDown(reply, { button: 0 })
  const range = document.createRange()
  range.selectNodeContents(reply)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  fireEvent.mouseUp(reply, { button: 0 })
  act(() => {
    vi.runOnlyPendingTimers()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  expect(appendText).toHaveBeenCalledWith('> Use the draft store.\n>\n> It already appends.\n\n')
  // The place is in the reply element's own text.
  expect(nativeChatQuoteSource('Use the draft store.\n\nIt already appends.')).toEqual({
    messageId: 'reply-1',
    place: { offset: 0, length: 41, hash: 'otso1p:41' }
  })
})
