// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { getByRole, queryByRole } from '@testing-library/react'
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
    const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    expect(document.activeElement).toBe(rows[0])
    expect([...rows].map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(getByRole(container, 'button', { name: 'Skip' })).toBeTruthy()

    act(() => rows[1]!.click())
    expect([...rows].map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    // The Enter hint is aria-hidden, so the button is still named "Submit".
    expect(getByRole(container, 'button', { name: 'Submit' })).toBeTruthy()
    expect(queryByRole(container, 'button', { name: 'Skip' })).toBeNull()
  })

  it('confirms with Enter on the chosen single-select row instead of deselecting it', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    const onAnswer = vi.fn()
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={{
            questions: [
              tabsOrSpaces.questions[0]!,
              {
                question: 'Two or four?',
                header: 'Width',
                multiSelect: false,
                options: [{ label: 'Two' }, { label: 'Four' }]
              }
            ]
          }}
          onAnswer={onAnswer}
          onCancel={() => {}}
          shouldFocus
        />
      )
    })
    const rows = (): HTMLButtonElement[] => [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    ]
    act(() => rows()[0]!.click())
    act(() => vi.runAllTimers())
    expect(rows()[0]!.textContent).toContain('Two')

    pressKey({ key: 'ArrowLeft' }, rows()[0]!)
    expect(rows()[0]!.textContent).toContain('Tabs')
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(container, 'button', { name: 'Next' })).toBeTruthy()
    act(() => rows()[0]!.focus())
    pressKey({ key: 'Enter' }, rows()[0]!)
    act(() => vi.runAllTimers())
    expect(rows()[0]!.textContent).toContain('Two')

    pressKey({ key: 'ArrowLeft' }, rows()[0]!)
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('true')
    // Click still toggles the chosen row off.
    act(() => rows()[0]!.click())
    expect(rows()[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(onAnswer).not.toHaveBeenCalled()
  })
  it('submits with a second Enter on the last step instead of deselecting the pick', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    const onAnswer = vi.fn()
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
    const rows = container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    act(() => rows[1]!.focus())
    pressKey({ key: 'Enter' }, rows[1]!)
    expect(rows[1]!.getAttribute('aria-pressed')).toBe('true')
    // Before the auto-advance fires, Enter on the chosen row submits it.
    pressKey({ key: 'Enter' }, rows[1]!)
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
    act(() => vi.runAllTimers())
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it('offers Submit on the last step once an earlier question is answered, even after skipping', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    const onAnswer = vi.fn()
    const onCancel = vi.fn()
    const question = (header: string): AskPrompt['questions'][number] => ({
      question: `${header}?`,
      header,
      multiSelect: false,
      options: [{ label: `${header} A` }, { label: `${header} B` }]
    })
    act(() => {
      root.render(
        <NativeChatQuestionCard
          prompt={{ questions: [question('One'), question('Two'), question('Three')] }}
          onAnswer={onAnswer}
          onCancel={onCancel}
          shouldFocus
        />
      )
    })
    const rows = (): HTMLButtonElement[] => [
      ...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    ]
    const skip = (): void => act(() => getByRole(container, 'button', { name: 'Skip' }).click())
    skip()
    skip()
    expect(rows()[0]!.textContent).toContain('Three A')
    // With nothing answered, the last step still offers Skip, which dismisses.
    expect(getByRole(container, 'button', { name: 'Skip' })).toBeTruthy()

    act(() =>
      container.querySelector<HTMLButtonElement>('[data-native-chat-question-step]')!.click()
    )
    act(() => rows()[1]!.click())
    act(() => vi.runAllTimers())
    skip()
    expect(rows()[0]!.textContent).toContain('Three A')
    expect(queryByRole(container, 'button', { name: 'Skip' })).toBeNull()
    act(() => getByRole(container, 'button', { name: 'Submit' }).click())
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAnswer).toHaveBeenCalledWith([
      { indices: [1], other: '' },
      { indices: [], other: '' },
      { indices: [], other: '' }
    ])
  })
})
