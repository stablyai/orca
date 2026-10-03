// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { AskPrompt } from './native-chat-interactive-prompt'

// The "Other" free-text row submits on Enter. A CJK IME also uses Enter to
// confirm a conversion candidate, so that keydown must be ignored or the
// answer is delivered mid-composition with a half-converted value (#17820).

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
})

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

function renderCard(onAnswer: (...args: unknown[]) => void): HTMLInputElement {
  act(() => {
    root.render(
      <NativeChatQuestionCard
        prompt={tabsOrSpaces}
        onAnswer={onAnswer}
        onCancel={() => {}}
        allowOther
      />
    )
  })
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('free-text input not rendered')
  }
  return input
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent(type, {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  Object.defineProperty(event, 'keyCode', { value: init?.keyCode ?? 13 })
  act(() => {
    input.dispatchEvent(event)
  })
}

// The carry armed by a confirm Enter expires on the next animation frame after keyup.
async function flushFrame(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
}

describe('NativeChatQuestionCard free-text IME Enter guard', () => {
  it('does not submit on the Enter that confirms a CJK IME composition (isComposing)', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { isComposing: true })

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('does not submit on the macOS-shaped confirm Enter (isComposing and keyCode 229)', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { isComposing: true, keyCode: 229 })

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('does not submit on an Enter the IME reports only as keyCode 229', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { keyCode: 229 })

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('swallows the unmarked Enter macOS redispatches right after a confirm', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { isComposing: true, keyCode: 229 })
    pressKey(input, 'keyup', { isComposing: false })
    pressKey(input, 'keydown', { isComposing: false })

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('submits the next deliberate Enter once the confirm gesture has expired', async () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { isComposing: true, keyCode: 229 })
    pressKey(input, 'keyup', { isComposing: false })
    await flushFrame()
    pressKey(input, 'keydown', { isComposing: false })

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '日本語' }])
  })

  it('releases composition ownership on blur even when compositionend is omitted', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    act(() => {
      input.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    })
    typeInto(input, '日本語')
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    pressKey(input, 'keydown', { isComposing: false })

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '日本語' }])
  })

  it('still submits the typed text on a plain Enter', () => {
    const onAnswer = vi.fn()
    const input = renderCard(onAnswer)
    typeInto(input, '日本語')

    pressKey(input, 'keydown', { isComposing: false })

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '日本語' }])
  })
})
