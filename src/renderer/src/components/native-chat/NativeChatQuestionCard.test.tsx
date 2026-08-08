// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'

// The card resolves its own label-keyed selection state into the index-based
// answer the delivery layer needs. These tests pin that resolution — the exact
// seam of STA-1860 (a non-first pick must surface as its option INDEX, not the
// first option / the raw label).

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

function render(prompt: AskPrompt, onAnswer: (s: AskAnswerSelection[]) => void): void {
  act(() => {
    root.render(<NativeChatQuestionCard prompt={prompt} onAnswer={onAnswer} onCancel={() => {}} />)
  })
}

function click(button: Element | undefined, describe: string): void {
  if (!button) {
    throw new Error(`button not found: ${describe}`)
  }
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

// Option rows carry a badge number + label, so match them by the label they
// contain among the aria-pressed selectable rows.
function clickOption(label: string): void {
  const row = [...container.querySelectorAll('button[aria-pressed]')].find((b) =>
    b.textContent?.includes(label)
  )
  click(row, `option ${label}`)
}

function clickOptionAt(index: number): void {
  click(container.querySelectorAll('button[aria-pressed]')[index], `option index ${index}`)
}

function clickAction(text: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text
  )
  click(button, text)
}

function typeAnswer(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(input: HTMLInputElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
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
  it('delivers the SECOND option as index 1, not the default (STA-1860)', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    clickOption('Spaces')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })

  it('delivers a multi-select pick as its option indices', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which fruits?',
            multiSelect: true,
            options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
          }
        ]
      },
      onAnswer
    )

    clickOption('Cherry')
    clickOption('Apple')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [0, 2], other: '' }])
  })

  it('keeps duplicate labels distinct by their numbered row', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which duplicate row?',
            multiSelect: false,
            options: [{ label: 'Same' }, { label: 'Same' }]
          }
        ]
      },
      onAnswer
    )

    clickOptionAt(1)
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })

  it('carries free text through as the other answer', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    const input = container.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'four spaces')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    clickAction('Submit')
    typeAnswer(input, 'four spaces')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'four spaces' }])
  })

  it('does not answer on the recorded Korean Enter redispatch', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '테스')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    const prevented = key(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(prevented).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('answers once on the deliberate Enter after the recorded IME confirmation', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '테스트')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
    key(input, 'keyup', { key: 'Process', code: 'Enter', keyCode: 229 })
    key(input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(onAnswer).not.toHaveBeenCalled()

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '테스트' }])
  })

  it('clears an unmatched IME confirmation on keyup', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '테스트')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    key(input, 'keyup', { key: 'Process', code: 'Enter', keyCode: 229 })

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '테스트' }])
  })

  it('clears IME confirmation ownership on blur', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '테스트')

    act(() => input.focus())
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    act(() => input.blur())
    act(() => input.focus())

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '테스트' }])
  })

  it('retains carry across a same-frame non-Enter keyup before redispatch', () => {
    const onAnswer = vi.fn()
    let frame: FrameRequestCallback | undefined
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frame = callback
        return 1
      })
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '테스트')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    key(input, 'keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 })
    const prevented = key(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(prevented).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
    frame?.(0)
    animationFrame.mockRestore()
  })

  it('expires carry before a deliberate Enter after the next frame', () => {
    const onAnswer = vi.fn()
    let frame: FrameRequestCallback | undefined
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frame = callback
        return 1
      })
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '中')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    key(input, 'keydown', { key: 'Process', code: 'Digit1', keyCode: 229, isComposing: true })
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    key(input, 'keyup', { key: '1', code: 'Digit1', keyCode: 49 })
    frame?.(0)
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '中' }])
    animationFrame.mockRestore()
  })

  it('keeps ordinary Enter behavior unchanged', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, 'abc')

    const prevented = key(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(prevented).toBe(true)
    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'abc' }])
  })

  // Regression: IMEs that report Process/229 for EVERY key (Pinyin candidate selection)
  // release a non-Enter key, so a Process-only keyup clear left the carry armed and
  // swallowed the user's next deliberate Enter. Shape from the recorded IBus number-
  // candidate trace in terminal-stock-composition.test.ts.
  it('answers on the deliberate Enter after a Pinyin number-candidate commit', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)
    const input = container.querySelector('input')!
    typeAnswer(input, '中')

    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    for (const code of ['KeyH', 'KeyO', 'KeyN', 'KeyG', 'Digit1']) {
      key(input, 'keydown', { key: 'Process', code, keyCode: 229, isComposing: true })
    }
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    // The carry expires on the next animation frame, never synchronously — macOS
    // delivers keyup before its unmarked redispatch. A human selecting a candidate and
    // then pressing Enter is many frames later, so advance one.
    let frame: FrameRequestCallback | undefined
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frame = cb
      return 1
    })
    key(input, 'keyup', { key: '1', code: 'Digit1', keyCode: 49 })
    act(() => frame?.(0))
    raf.mockRestore()

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onAnswer).toHaveBeenCalledOnce()
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: '中' }])
  })
})
