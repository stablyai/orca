// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../shared/native-chat/input/native-chat-question-auto-advance'
import type { AskPrompt } from '../../../../../shared/native-chat/input/native-chat-ask-types'

// Answers must use option indices; labels can be duplicated and a non-first choice must retain its position.

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function pressKey(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const tabsOrSpaces: AskPrompt = {
  questions: [
    {
      question: 'Do you prefer tabs or spaces?',
      header: 'Indent',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
}

describe('NativeChatQuestionCard', () => {
  it('arrows past a title checkbox into the multiline answer and leaves only at its text edges', () => {
    container.setAttribute('data-native-chat-root', 'true')
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={{
            questions: [{ ...tabsOrSpaces.questions[0]!, question: '- [ ] Tabs or spaces?' }]
          }}
          onAnswer={() => {}}
          onCancel={() => {}}
          freeTextInputs={[{ multiline: true }]}
          shouldFocus
        />
      )
    })
    const field = container.querySelector('textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(field, 'first\nlast')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    field.setSelectionRange(0, 0)
    act(() => rows[1]!.focus())
    pressKey({ key: 'ArrowDown' }, rows[1]!)
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([10, 10])
    const pressAt = (start: number, end: number, key: string): boolean => {
      act(() => field.focus())
      field.setSelectionRange(start, end)
      return pressKey({ key }, field).defaultPrevented
    }

    expect(pressAt(3, 3, 'ArrowUp')).toBe(false)
    expect(pressAt(0, 0, 'ArrowDown')).toBe(false)
    expect(pressAt(0, 10, 'ArrowDown')).toBe(false)
    expect(document.activeElement).toBe(field)
    expect(pressAt(0, 0, 'ArrowUp')).toBe(true)
    expect(document.activeElement).toBe(rows[1])
    expect(pressAt(10, 10, 'ArrowDown')).toBe(true)
    expect(document.activeElement).toBe(rows[0])
  })
  it('focuses a question inside a dialog and keeps number keys scoped to that dialog', () => {
    vi.useFakeTimers()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    container.before(dialog)
    dialog.append(container)
    const onAnswer = vi.fn()
    const dialogControl = dialog.appendChild(document.createElement('button'))
    act(() => dialogControl.focus())
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={tabsOrSpaces}
          onAnswer={onAnswer}
          onCancel={() => {}}
          shouldFocus
        />
      )
    })
    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
    expect(document.activeElement).toBe(option)
    expect(pressKey({ key: '2' }, option).defaultPrevented).toBe(true)
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1], other: '' }])
    const outside = document.body.appendChild(document.createElement('button'))
    act(() => outside.focus())
    expect(pressKey({ key: '1' }, outside).defaultPrevented).toBe(false)
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    outside.remove()
    dialog.replaceWith(container)
  })
})
