// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../shared/native-chat/input/questions/native-chat-question-auto-advance'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

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
    const card = container.querySelector<HTMLElement>('[data-native-chat-question-card]')!
    expect(document.activeElement).toBe(card)
    expect(pressKey({ key: '2' }, card).defaultPrevented).toBe(true)
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
