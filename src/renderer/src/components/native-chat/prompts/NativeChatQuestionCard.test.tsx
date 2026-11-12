// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

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

  it('shows a picked preview, keeps it on a second click, and confirms the digit-named option with Enter', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    const onAnswer = vi.fn()
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'Which layout?',
                multiSelect: false,
                options: [
                  { label: 'Sidebar', preview: '| nav | main |' },
                  { label: 'Top bar', preview: '| nav |\n| main |' }
                ]
              }
            ]
          }}
          onAnswer={onAnswer}
          onCancel={() => {}}
          shouldFocus
        />
      )
    })
    const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    act(() => rows[0]!.focus())
    pressKey({ key: '2' }, rows[0]!)
    act(() => rows[1]!.click())
    act(() => vi.runAllTimers())
    expect(container.querySelector('pre')?.textContent).toBe('| nav |\n| main |')
    expect(document.activeElement).toBe(rows[1])
    expect(onAnswer).not.toHaveBeenCalled()
    pressKey({ key: 'ArrowUp' }, rows[1]!)
    pressKey({ key: '2' }, rows[0]!)
    expect(document.activeElement).toBe(rows[1])
    pressKey({ key: 'Enter' }, rows[1]!)
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })
  it('opens with focus on option 1 without picking it, and Skip turns into Submit once picked', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={tabsOrSpaces}
          onAnswer={() => {}}
          onCancel={() => {}}
          shouldFocus
        />
      )
    })
    act(() => vi.runAllTimers())
    const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    const confirmButton = (): HTMLButtonElement =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        /^(Skip|Submit)/.test(button.textContent ?? '')
      )!
    expect(document.activeElement).toBe(rows[0])
    // Focus is a ring only; the picked look (primary border, fill) is reserved for aria-pressed rows.
    expect(rows[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(rows[0]!.className).not.toMatch(/(^|\s)(focus:)?bg-accent(\s|$)/)
    expect(rows[0]!.className).not.toContain('border-primary')
    expect(confirmButton().textContent).toBe('Skip')

    act(() => rows[1]!.click())
    expect(rows[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(rows[1]!.className).toContain('border-primary')
    expect(rows[0]!.className).not.toContain('border-primary')
    // The Enter hint is decoration; the button's name stays "Submit".
    const submit = confirmButton()
    expect(submit.querySelector('[aria-hidden]')?.textContent).toBe('↵')
    expect(
      [...submit.childNodes]
        .filter((node) => !(node instanceof Element && node.hasAttribute('aria-hidden')))
        .map((node) => node.textContent)
        .join('')
    ).toBe('Submit')
  })
})
