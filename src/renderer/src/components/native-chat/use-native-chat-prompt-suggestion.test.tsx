// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { useNativeChatPromptSuggestion } from './use-native-chat-prompt-suggestion'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { EMPTY_HISTORY } from './native-chat-composer-state'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Composer({
  scope = 'one',
  suggestion = 'Add tests',
  enabled = true,
  read,
  sent
}: {
  scope?: string
  suggestion?: string | null
  enabled?: boolean
  read?: () => string | null
  sent: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const next = useNativeChatPromptSuggestion({
    scopeKey: scope,
    enabled,
    draft,
    suggestion,
    readTerminalSuggestion: read,
    inputRef,
    insertTypedText: (text) => {
      setDraft(text)
      return true
    }
  })
  const keyDown = useNativeChatComposerKeyDown({
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    draft,
    history: EMPTY_HISTORY,
    isComposing: () => composing,
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: () => {
      if (draft) {
        sent(draft)
        setDraft('')
      }
    },
    acceptPromptSuggestion: next.accept,
    dismissPromptSuggestion: next.dismiss,
    setDraft,
    setCaret: vi.fn(),
    setHistory: vi.fn(),
    setActiveSuggestion: vi.fn()
  })
  return (
    <textarea
      ref={inputRef}
      value={draft}
      placeholder={next.promptSuggestion ?? ''}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={keyDown}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
    />
  )
}

it.each(['Tab', 'ArrowRight'])(
  'accepts %s into an editable draft and sends only on Enter',
  (key) => {
    const sent = vi.fn()
    render(<Composer sent={sent} />)
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('placeholder')).toBe('Add tests')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sent).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key })
    expect(input).toHaveProperty('value', 'Add tests')
    expect(sent).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(sent).toHaveBeenCalledWith('Add tests')
    expect(input.getAttribute('placeholder')).toBe('')
  }
)

it('preserves Tab navigation, IME text and the user draft', () => {
  render(<Composer sent={vi.fn()} />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
  expect(input).toHaveProperty('value', '')
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Tab', isComposing: true })
  expect(input).toHaveProperty('value', '')
  fireEvent.change(input, { target: { value: 'my own prompt' } })
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Tab' })
  expect(input).toHaveProperty('value', 'my own prompt')
  fireEvent.change(input, { target: { value: '' } })
  expect(input.getAttribute('placeholder')).toBe('')
})

it('dismisses suggestions, hides while working and resets for a different session', () => {
  const sent = vi.fn()
  const view = render(<Composer sent={sent} />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input.getAttribute('placeholder')).toBe('')
  view.rerender(<Composer scope="two" sent={sent} />)
  expect(input.getAttribute('placeholder')).toBe('Add tests')
  view.rerender(<Composer scope="two" enabled={false} sent={sent} />)
  expect(input.getAttribute('placeholder')).toBe('')
})

it('rechecks terminal evidence on acceptance and drops it when the PTY changes', () => {
  vi.useFakeTimers()
  let text: string | null = 'Add tests'
  const read = () => text
  const sent = vi.fn()
  const view = render(<Composer suggestion={null} read={read} sent={sent} />)
  const input = screen.getByRole('textbox')
  expect(input.getAttribute('placeholder')).toBe('Add tests')
  text = null
  fireEvent.keyDown(input, { key: 'Tab' })
  expect(input).toHaveProperty('value', '')
  act(() => {
    vi.advanceTimersByTime(500)
  })
  expect(input.getAttribute('placeholder')).toBe('')
  view.rerender(<Composer scope="new-pty" suggestion={null} read={read} sent={sent} />)
  expect(input.getAttribute('placeholder')).toBe('')
})
