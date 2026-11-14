// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { getByRole, queryByRole } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard, type NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import { TooltipProvider } from '@/components/ui/tooltip'

import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

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

function renderCard(
  props: Partial<NativeChatQuestionCardProps> & Pick<NativeChatQuestionCardProps, 'prompt'>
): void {
  container.setAttribute('data-native-chat-root', 'true')
  act(() => {
    root.render(
      <TooltipProvider>
        <NativeChatQuestionCard onAnswer={() => {}} onCancel={() => {}} shouldFocus {...props} />
      </TooltipProvider>
    )
  })
}

const card = (): HTMLElement => container.querySelector<HTMLElement>('[role="group"]')!
const optionRows = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
]

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

  it('offers Skip and submit on the last step once an earlier question is answered', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    const onCancel = vi.fn()
    renderCard({
      prompt: { questions: [question('One'), question('Two'), question('Three')] },
      onAnswer,
      onCancel
    })
    const skip = (): void => act(() => getByRole(container, 'button', { name: 'Skip' }).click())
    skip()
    skip()
    expect(optionRows()[0]!.textContent).toContain('Three A')
    // With nothing answered, the last step still offers Skip, which dismisses.
    expect(getByRole(container, 'button', { name: 'Skip' })).toBeTruthy()

    act(() => getByRole(container, 'button', { name: 'One' }).click())
    act(() => optionRows()[1]!.click())
    act(() => vi.runAllTimers())
    skip()
    expect(optionRows()[0]!.textContent).toContain('Three A')
    expect(queryByRole(container, 'button', { name: 'Skip' })).toBeNull()
    act(() => getByRole(container, 'button', { name: 'Skip and submit' }).click())
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAnswer).toHaveBeenCalledWith([
      { indices: [1], other: '' },
      { indices: [], other: '' },
      { indices: [], other: '' }
    ])
  })

  it('opens on the card itself so no option looks picked, and steps and confirms from there', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    renderCard({ prompt: { questions: [question('One'), question('Two')] }, onAnswer })
    expect(document.activeElement).toBe(card())
    expect(card().getAttribute('aria-label')).toBe('One, 1 of 2: One?')
    expect(optionRows().map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    // Enter on the card with nothing answered neither picks option 1 nor moves on.
    pressKey({ key: 'Enter' }, card())
    expect(optionRows().map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(container.textContent).toContain('1 of 2')
    pressKey({ key: 'ArrowRight' }, card())
    expect(container.textContent).toContain('2 of 2')
    expect(document.activeElement).toBe(card())
    pressKey({ key: 'ArrowLeft' }, card())
    expect(container.textContent).toContain('1 of 2')
    pressKey({ key: '2' }, card())
    act(() => vi.runAllTimers())
    expect(container.textContent).toContain('2 of 2')
    pressKey({ key: '1' }, card())
    act(() => card().focus())
    pressKey({ key: 'Enter' }, card())
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith([
      { indices: [1], other: '' },
      { indices: [0], other: '' }
    ])
  })

  it('jumps from the step bar, marks answered steps and moves back from step 2', () => {
    vi.useFakeTimers()
    renderCard({ prompt: { questions: [question('One'), question('Two'), question('Three')] } })
    expect(getByRole(container, 'button', { name: 'Previous question' })).toHaveProperty(
      'disabled',
      true
    )
    expect(queryByRole(container, 'button', { name: 'Back' })).toBeNull()
    act(() => optionRows()[0]!.click())
    act(() => vi.runAllTimers())
    expect(container.textContent).toContain('2 of 3')
    expect(getByRole(container, 'button', { name: 'One, answered' })).toBeTruthy()
    act(() => getByRole(container, 'button', { name: 'Three' }).click())
    expect(container.textContent).toContain('3 of 3')
    expect(getByRole(container, 'button', { name: 'Next question' })).toHaveProperty(
      'disabled',
      true
    )
    act(() => getByRole(container, 'button', { name: 'Back' }).click())
    expect(container.textContent).toContain('2 of 3')
  })

  it('shows a trailing (Recommended) as a pill while the option keeps its full name', () => {
    renderCard({
      prompt: {
        questions: [
          {
            question: 'Indent?',
            multiSelect: false,
            options: [{ label: 'Spaces (Recommended)' }, { label: 'Tabs' }]
          }
        ]
      }
    })
    const recommended = getByRole(container, 'button', { name: /Spaces \(Recommended\)/ })
    expect(recommended.querySelector('[aria-hidden="true"]')?.textContent).toBe('Spaces')
    expect(recommended.textContent).toContain('Recommended')
    expect(optionRows()[1]!.textContent).toBe('2Tabs')
  })

  it('sends once per press before the caller answers, retries after a refusal, and holds while pending', () => {
    // The caller refuses every answer (no pending state), so each later press must try again.
    const onAnswer = vi.fn()
    renderCard({ prompt: tabsOrSpaces, onAnswer })
    act(() => optionRows()[0]!.focus())
    pressKey({ key: 'Enter' }, optionRows()[0]!)
    // Two presses before the next commit: the second must not send again.
    act(() => {
      for (let i = 0; i < 2; i++) {
        optionRows()[0]!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
      }
    })
    expect(onAnswer).toHaveBeenCalledTimes(1)
    pressKey({ key: 'Enter' }, optionRows()[0]!)
    expect(onAnswer).toHaveBeenCalledTimes(2)
    renderCard({ prompt: tabsOrSpaces, onAnswer, isSubmitting: true })
    pressKey({ key: 'Enter' }, card())
    renderCard({ prompt: tabsOrSpaces, onAnswer, isCancelling: true })
    act(() => card().focus())
    pressKey({ key: 'Enter' }, card())
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })

  it('answers one typed step per Enter press, never with a held key', () => {
    const onAnswer = vi.fn()
    const typed = (header: string): AskPrompt['questions'][number] => ({
      question: `${header}?`,
      header,
      multiSelect: false,
      options: []
    })
    renderCard({ prompt: { questions: [typed('One'), typed('Two'), typed('Three')] }, onAnswer })
    const field = (): HTMLTextAreaElement => container.querySelector('textarea')!
    const type = (value: string): void =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(field(), value)
        field().dispatchEvent(new Event('input', { bubbles: true }))
      })
    type('first')
    pressKey({ key: 'Enter' }, field())
    expect(container.textContent).toContain('2 of 3')
    // The key is still down: auto-repeat must not answer step 2 for the person.
    pressKey({ key: 'Enter', repeat: true }, field())
    pressKey({ key: 'Enter', repeat: true }, field())
    expect(container.textContent).toContain('2 of 3')
    type('second')
    pressKey({ key: 'Enter' }, field())
    type('third')
    pressKey({ key: 'Enter', repeat: true }, field())
    expect(onAnswer).not.toHaveBeenCalled()
    pressKey({ key: 'Enter' }, field())
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })
})

function question(header: string): AskPrompt['questions'][number] {
  return {
    question: `${header}?`,
    header,
    multiSelect: false,
    options: [{ label: `${header} A` }, { label: `${header} B` }]
  }
}
