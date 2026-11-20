// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { typeIntoBotItemComment } from './bot-item-comment-typing'

afterEach(cleanup)

// The item pane as BotItemPane wires it: a React key handler over the pane's own DOM.
function renderPane(choices = 0): { typed: ReturnType<typeof vi.fn> } {
  const typed = vi.fn()
  function Pane(): React.JSX.Element {
    return (
      <div
        data-testid="pane"
        tabIndex={-1}
        onKeyDown={(event) => typeIntoBotItemComment(event, event.currentTarget, { type: typed })}
      >
        <h2>Decide: should paused bots get mail?</h2>
        <input aria-label="Other input" />
        <button type="button">Reply</button>
        {choices > 0 ? (
          <div data-native-chat-prompt-card-focus data-native-chat-question-options={choices} />
        ) : null}
      </div>
    )
  }
  render(<Pane />)
  return { typed }
}

it('sends printable keys from the pane to the comment box', () => {
  const { typed } = renderPane()
  const heading = screen.getByRole('heading')

  expect(fireEvent.keyDown(heading, { key: 'a' })).toBe(false)
  fireEvent.keyDown(heading, { key: 'A', shiftKey: true })
  fireEvent.keyDown(screen.getByRole('button'), { key: 'q' })

  expect(typed.mock.calls).toEqual([['a'], ['A'], ['q']])
})

it('leaves shortcuts, Esc, arrows and Tab alone', () => {
  const { typed } = renderPane()
  const pane = screen.getByTestId('pane')

  fireEvent.keyDown(pane, { key: 'k', metaKey: true })
  fireEvent.keyDown(pane, { key: 'k', ctrlKey: true })
  fireEvent.keyDown(pane, { key: 'k', altKey: true })
  for (const key of ['Escape', 'ArrowDown', 'ArrowLeft', 'Tab', 'Enter']) {
    fireEvent.keyDown(pane, { key })
  }

  expect(typed).not.toHaveBeenCalled()
})

it('leaves keys typed into another input, and Space on a button, where they are', () => {
  const { typed } = renderPane()

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Other input' }), { key: 'a' })
  fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })

  expect(typed).not.toHaveBeenCalled()
})

it('leaves a key the IME is composing alone', () => {
  const { typed } = renderPane()
  const heading = screen.getByRole('heading')

  expect(fireEvent.keyDown(heading, { key: 'a', isComposing: true })).toBe(true)
  expect(fireEvent.keyDown(heading, { key: 'a', keyCode: 229 })).toBe(true)

  expect(typed).not.toHaveBeenCalled()
})

it("leaves a digit naming one of the open card's choices to the card, and types any other", () => {
  const { typed } = renderPane(2)
  const heading = screen.getByRole('heading')

  fireEvent.keyDown(heading, { key: '2' })
  fireEvent.keyDown(heading, { key: '9' })

  expect(typed.mock.calls).toEqual([['9']])
})
