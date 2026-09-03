// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceEmojiShortcodeInput } from './useWorkspaceEmojiShortcodeInput'

function EmojiInputHarness({
  initialValue,
  onUnhandledKeyDown
}: {
  initialValue: string
  onUnhandledKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const emojiInput = useWorkspaceEmojiShortcodeInput({
    inputRef,
    onValueChange: setValue,
    value
  })

  return (
    <div data-emoji-menu-open={emojiInput.open ? 'true' : 'false'}>
      <input
        ref={inputRef}
        aria-label="Workspace name"
        value={value}
        onChange={(event) =>
          emojiInput.handleValueChange(
            event.currentTarget.value,
            event.currentTarget.selectionStart
          )
        }
        onSelect={(event) => emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => {
          if (!emojiInput.handleKeyDown(event)) {
            onUnhandledKeyDown?.(event)
          }
        }}
      />
      {emojiInput.suggestions.map((suggestion) => (
        <button
          key={suggestion.shortcode}
          type="button"
          onClick={() => emojiInput.selectSuggestion(suggestion)}
        >
          :{suggestion.shortcode}:
        </button>
      ))}
    </div>
  )
}

describe('useWorkspaceEmojiShortcodeInput', () => {
  afterEach(cleanup)

  it('replaces a completed shortcode without discarding trailing text', () => {
    render(<EmojiInputHarness initialValue="Launch " />)
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    fireEvent.change(input, {
      target: { value: 'Launch :wink: experiment', selectionStart: 13 }
    })

    expect((input as HTMLInputElement).value).toBe('Launch 😉 experiment')
  })

  it('opens suggestions and accepts the highlighted emoji with Enter', () => {
    render(<EmojiInputHarness initialValue="Launch " />)
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    fireEvent.change(input, { target: { value: 'Launch :wink', selectionStart: 12 } })

    expect(screen.getByText(':wink:')).toBeTruthy()
    expect(input.parentElement?.dataset.emojiMenuOpen).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((input as HTMLInputElement).value).toBe('Launch 😉 ')
  })

  it('dismisses suggestions with Escape without clearing the query', () => {
    render(<EmojiInputHarness initialValue="Launch " />)
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    fireEvent.change(input, { target: { value: 'Launch :wink', selectionStart: 12 } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect((input as HTMLInputElement).value).toBe('Launch :wink')
    expect(input.parentElement?.dataset.emojiMenuOpen).toBe('false')
  })

  it('leaves composing arrow navigation to the IME', () => {
    const onUnhandledKeyDown = vi.fn()
    render(
      <EmojiInputHarness initialValue="Launch :wink" onUnhandledKeyDown={onUnhandledKeyDown} />
    )
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    ;(input as HTMLInputElement).setSelectionRange(12, 12)
    fireEvent.select(input)
    const handled = fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })

    expect(handled).toBe(true)
    expect(onUnhandledKeyDown).not.toHaveBeenCalled()
  })

  it('does not accept or submit on a composing Enter', () => {
    const onUnhandledKeyDown = vi.fn()
    render(
      <EmojiInputHarness initialValue="Launch :wink" onUnhandledKeyDown={onUnhandledKeyDown} />
    )
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    ;(input as HTMLInputElement).setSelectionRange(12, 12)
    fireEvent.select(input)
    const handled = fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(handled).toBe(true)
    expect(onUnhandledKeyDown).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('Launch :wink')
  })
})
