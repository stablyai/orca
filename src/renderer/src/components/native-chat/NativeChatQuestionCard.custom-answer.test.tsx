// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render as renderComponent } from '@testing-library/react'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../shared/native-chat-question-auto-advance'

let container: HTMLDivElement
const onAnswer = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  onAnswer.mockClear()
  container = document.createElement('div')
  container.setAttribute('data-native-chat-root', 'true')
  document.body.appendChild(container)
})

afterEach(() => {
  cleanup()
  container.remove()
  vi.useRealTimers()
})

function render(allowOther = true, multiline = false): void {
  renderComponent(
    <NativeChatQuestionCard
      prompt={{
        questions: [
          {
            question: 'Which branch?',
            multiSelect: false,
            options: [{ label: 'main' }, { label: 'release' }]
          }
        ]
      }}
      allowOther={allowOther}
      freeTextInputs={[{ multiline }]}
      shouldFocus
      onAnswer={onAnswer}
      onCancel={() => {}}
    />,
    { container }
  )
}

function tab(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => target.dispatchEvent(event))
  return event
}

it.each([false, true])(
  'Tabs directly from an option to custom text (multiline: %s)',
  (multiline) => {
    render(true, multiline)
    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
    const input = container.querySelector('input, textarea')!

    expect(document.activeElement).toBe(option)
    expect(tab(option).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(tab(input).defaultPrevented).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
  }
)

it('cancels a pending option submission so Tab can switch to a typed answer', () => {
  render()
  const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
  const input = container.querySelector('input')!

  fireEvent.click(option)
  tab(option)
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
  expect(onAnswer).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: 'feature/custom' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [], other: 'feature/custom' }])
})

it('preserves normal tabbing when custom answers are unavailable', () => {
  render(false)
  const option = container.querySelector('button[aria-pressed]')!
  expect(tab(option).defaultPrevented).toBe(false)
  expect(container.querySelector('input, textarea')).toBeNull()
})

it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }])(
  'preserves modified Tab and composition: %j',
  (init) => {
    render()
    const option = container.querySelector('button[aria-pressed]')!
    expect(tab(option, init).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(option)
  }
)

it('leaves Tab on other controls and panes alone', () => {
  render()
  const cancel = container.querySelector('button[aria-label="Cancel"]')!
  const outside = document.body.appendChild(document.createElement('button'))
  try {
    expect(tab(cancel).defaultPrevented).toBe(false)
    expect(tab(outside).defaultPrevented).toBe(false)
  } finally {
    outside.remove()
  }
})
