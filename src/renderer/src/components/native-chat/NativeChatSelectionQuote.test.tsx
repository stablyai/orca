// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { NativeChatSelectionQuote } from './NativeChatSelectionQuote'
import { NATIVE_CHAT_QUOTE_SOURCE_PROPS } from './native-chat-quote-selection'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const appendText = vi.fn<(text: string) => void>()
const acceptsText = vi.fn(() => true)
const composer: NativeChatComposerHandle = {
  focus: () => true,
  insertTypedText: () => true,
  appendText,
  acceptsText,
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false
}

function Chat(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef}>
      <p data-testid="user">my own prompt</p>
      <div {...NATIVE_CHAT_QUOTE_SOURCE_PROPS}>
        <pre data-testid="first">{'Use the draft store.\n\nIt already appends.'}</pre>
      </div>
      <time data-testid="time" style={{ userSelect: 'none' }}>
        10:42
      </time>
      <p data-testid="next">a tool line</p>
      <NativeChatSelectionQuote rootRef={rootRef} composerRef={{ current: composer }} enabled />
    </div>
  )
}

function select(from: HTMLElement, to: HTMLElement = from, endOffset?: number): void {
  const range = document.createRange()
  range.setStart(from.firstChild!, 0)
  range.setEnd(to.firstChild!, endOffset ?? to.textContent!.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

function settle(): void {
  act(() => {
    vi.runOnlyPendingTimers()
  })
}

function releaseSelection(from: HTMLElement, to: HTMLElement = from, endOffset?: number): void {
  fireEvent.pointerDown(from, { button: 0 })
  select(from, to, endOffset)
  fireEvent.mouseUp(to, { button: 0 })
  settle()
}

describe('NativeChatSelectionQuote', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    window.getSelection()?.removeAllRanges()
    appendText.mockClear()
    acceptsText.mockReset().mockReturnValue(true)
    vi.useRealTimers()
  })

  it('quotes a selection from an agent reply into the composer as a blockquote', () => {
    render(<Chat />)
    releaseSelection(screen.getByTestId('first'))

    const quote = screen.getByRole('button', { name: 'Add to chat' })
    fireEvent.pointerDown(quote, { button: 0 })
    fireEvent.click(quote)

    expect(appendText).toHaveBeenCalledWith('> Use the draft store.\n>\n> It already appends.\n\n')
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })

  it('offers nothing for a selection outside an agent reply', () => {
    render(<Chat />)
    releaseSelection(screen.getByTestId('user'))
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()

    releaseSelection(screen.getByTestId('user'), screen.getByTestId('first'))
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })

  it('takes a selection that runs on over text that cannot be selected', () => {
    render(<Chat />)
    releaseSelection(screen.getByTestId('first'), screen.getByTestId('time'))
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    // A triple-click's range: it ends at the very start of the next block.
    releaseSelection(screen.getByTestId('first'), screen.getByTestId('next'), 0)
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    releaseSelection(screen.getByTestId('first'), screen.getByTestId('next'))
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })

  it('offers nothing when a press leaves the selection as it was', () => {
    render(<Chat />)
    releaseSelection(screen.getByTestId('first'))
    fireEvent.pointerDown(screen.getByTestId('time'), { button: 0 })
    fireEvent.mouseUp(screen.getByTestId('time'), { button: 0 })
    settle()

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })

  it('offers a selection made with the keyboard', () => {
    render(<Chat />)
    select(screen.getByTestId('first'))
    fireEvent.keyUp(screen.getByTestId('first'), { key: 'ArrowRight', shiftKey: true })
    settle()

    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()
  })

  it('offers nothing while the composer cannot take text', () => {
    acceptsText.mockReturnValue(false)
    render(<Chat />)
    releaseSelection(screen.getByTestId('first'))

    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })

  it('withdraws the offer once the selection is gone', () => {
    render(<Chat />)
    releaseSelection(screen.getByTestId('first'))
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy()

    act(() => {
      window.getSelection()!.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })
})
