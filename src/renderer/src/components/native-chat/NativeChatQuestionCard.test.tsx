// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../shared/native-chat-question-auto-advance'

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

function render(
  prompt: AskPrompt,
  onAnswer: (s: AskAnswerSelection[]) => void,
  allowOther: boolean | readonly boolean[] = true,
  shouldFocus = false
): void {
  act(() => {
    root.render(
      <NativeChatQuestionCard
        prompt={prompt}
        onAnswer={onAnswer}
        onCancel={() => {}}
        allowOther={allowOther}
        shouldFocus={shouldFocus}
      />
    )
  })
}

function pressKey(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function passAutoAdvanceBeat(): void {
  act(() => vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS))
}

function cardTitle(): string | null | undefined {
  return container.querySelector('[data-testid="native-chat-question-card-title"]')?.textContent
}

function click(button: Element | undefined, describe: string): void {
  if (!button) {
    throw new Error(`button not found: ${describe}`)
  }
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

// Match option labels within selectable rows because their text also includes badge numbers.
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

function typeAnswer(value: string): void {
  const input = container.querySelector('input')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function optionPressed(label: string): string | null | undefined {
  return [...container.querySelectorAll('button[aria-pressed]')]
    .find((b) => b.textContent?.includes(label))
    ?.getAttribute('aria-pressed')
}

const indentThenFruits: AskPrompt = {
  questions: [
    {
      question: 'Do you prefer tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    },
    {
      question: 'Which fruit?',
      multiSelect: false,
      options: [{ label: 'Apple' }, { label: 'Banana' }]
    }
  ]
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

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'four spaces' }])
  })

  it('hides free text when the provider requires a listed option', () => {
    render(tabsOrSpaces, vi.fn(), false)

    expect(container.querySelector('input')).toBeNull()
    expect(container.textContent).not.toContain('Type your answer')
  })

  it('applies free-text capability per question in a grouped prompt', () => {
    render(
      {
        questions: [
          {
            header: 'Listed',
            question: 'Pick a listed value',
            multiSelect: false,
            options: [{ label: 'One' }]
          },
          {
            header: 'Custom',
            question: 'Provide a custom value',
            multiSelect: false,
            options: []
          }
        ]
      },
      vi.fn(),
      [false, true]
    )

    expect(container.querySelector('input')).toBeNull()
    clickAction('Skip')
    expect(container.querySelector('input')).not.toBeNull()
  })

  it('submits grouped multi-select and free-text answers together', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            header: 'Targets',
            question: 'Which targets?',
            multiSelect: true,
            options: [{ label: 'Web' }, { label: 'Mobile' }]
          },
          {
            header: 'Notes',
            question: 'Anything else?',
            multiSelect: false,
            options: []
          }
        ]
      },
      onAnswer,
      [false, true]
    )

    clickOption('Web')
    clickOption('Mobile')
    clickAction('Next')
    const input = container.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'SSH host')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([
      { indices: [0, 1], other: '' },
      { indices: [], other: 'SSH host' }
    ])
  })

  it('replaces a picked option with a typed answer on a single-select question', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    clickOption('Spaces')
    typeAnswer('two spaces')
    expect(optionPressed('Spaces')).toBe('false')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'two spaces' }])
  })

  it('keeps typed text in the field but sends a later-picked option', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    typeAnswer('two spaces')
    clickOption('Tabs')
    expect(container.querySelector('input')!.value).toBe('two spaces')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [0], other: '' }])
  })

  it('chooses the kept typed text again when its field is clicked', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    typeAnswer('two spaces')
    clickOption('Tabs')
    act(() => {
      container.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(optionPressed('Tabs')).toBe('false')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'two spaces' }])
  })

  it('ignores a click on the answer field while the answer is sending', () => {
    const renderCard = (isSubmitting: boolean): void => {
      act(() => {
        root.render(
          <NativeChatQuestionCard
            prompt={tabsOrSpaces}
            onAnswer={vi.fn()}
            onCancel={() => {}}
            isSubmitting={isSubmitting}
          />
        )
      })
    }
    renderCard(false)
    typeAnswer('two spaces')
    clickOption('Tabs')
    renderCard(true)
    // Chromium still delivers pointer events to a disabled input.
    const input = container.querySelector('input')!
    act(() => {
      input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(optionPressed('Tabs')).toBe('true')
  })

  it('keeps the picked option when keyboard focus passes through the field', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    typeAnswer('two spaces')
    clickOption('Tabs')
    act(() => {
      container.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [0], other: '' }])
  })

  it('leaves nothing chosen when a picked option is unpicked over kept text', () => {
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    typeAnswer('two spaces')
    clickOption('Tabs')
    clickOption('Tabs')

    expect(optionPressed('Tabs')).toBe('false')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Skip')
    ).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('sends picked options and typed text together on a multi-select question', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'Which targets?',
            multiSelect: true,
            options: [{ label: 'Web' }, { label: 'Mobile' }]
          }
        ]
      },
      onAnswer
    )

    clickOption('Mobile')
    typeAnswer('Desktop')
    typeAnswer('')
    typeAnswer('Desktop app')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: 'Desktop app' }])
  })

  it('moves to the next question after a pick and sends after the last one', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(indentThenFruits, onAnswer)

    clickOption('Spaces')
    expect(optionPressed('Spaces')).toBe('true')
    expect(cardTitle()).toBe('Do you prefer tabs or spaces?')
    passAutoAdvanceBeat()
    expect(cardTitle()).toBe('Which fruit?')
    expect(onAnswer).not.toHaveBeenCalled()
    clickOption('Apple')
    passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
      { indices: [1], other: '' },
      { indices: [0], other: '' }
    ])
  })

  it('sends nothing when the question is cancelled before the pick moves on', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer)

    clickOption('Spaces')
    click(container.querySelector('button[aria-label="Cancel"]') ?? undefined, 'Cancel')
    passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('highlights the first option without choosing, then arrows and Enter answer each step', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    container.setAttribute('data-native-chat-root', 'true')
    render(
      { questions: [tabsOrSpaces.questions[0]!, tabsOrSpaces.questions[0]!] },
      onAnswer,
      true,
      true
    )
    expect(document.activeElement?.textContent).toContain('Tabs')
    expect(optionPressed('Tabs')).toBe('false')
    const conversation = container.appendChild(document.createElement('div'))
    conversation.tabIndex = 0
    act(() => conversation.focus())
    for (const key of ['ArrowUp', 'ArrowDown']) {
      expect(pressKey({ key }, conversation).defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(conversation)
    }
    act(() => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.focus())
    pressKey({ key: 'ArrowDown' }, document.activeElement!)
    expect(document.activeElement?.textContent).toContain('Spaces')
    expect(optionPressed('Spaces')).toBe('false')
    expect(onAnswer).not.toHaveBeenCalled()
    pressKey({ key: 'Enter' }, document.activeElement!)
    passAutoAdvanceBeat()
    expect(document.activeElement?.textContent).toContain('Tabs')
    pressKey({ key: 'ArrowUp' }, document.activeElement!)
    expect(document.activeElement?.textContent).toContain('Spaces')
    pressKey({ key: 'Enter' }, document.activeElement!)
    passAutoAdvanceBeat()
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([
      { indices: [1], other: '' },
      { indices: [1], other: '' }
    ])
  })

  it('toggles highlighted multi-select options without submitting and leaves editable keys alone', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    container.setAttribute('data-native-chat-root', 'true')
    render(
      { questions: [{ ...tabsOrSpaces.questions[0]!, multiSelect: true }] },
      onAnswer,
      true,
      true
    )
    pressKey({ key: 'Enter' }, document.activeElement!)
    pressKey({ key: 'ArrowDown' }, document.activeElement!)
    pressKey({ key: 'Enter', repeat: true }, document.activeElement!)
    pressKey({ key: 'Enter', isComposing: true }, document.activeElement!)
    pressKey({ key: 'Enter', ctrlKey: true }, document.activeElement!)
    expect(optionPressed('Spaces')).toBe('false')
    pressKey({ key: 'Enter' }, document.activeElement!)
    const input = container.querySelector('input')!
    act(() => input.focus())
    expect(pressKey({ key: 'ArrowUp' }, input).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
    typeAnswer('Other')
    expect(document.activeElement).toBe(input)
    passAutoAdvanceBeat()
    expect(onAnswer).not.toHaveBeenCalled()
    clickAction('Submit')
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [0, 1], other: 'Other' }])
  })

  it('picks the numbered option including a Shift-produced digit', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(tabsOrSpaces, onAnswer, true, true)

    pressKey({ key: '2', shiftKey: true })
    passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1], other: '' }])
  })

  it('toggles multi-select options by number key and waits for Submit', () => {
    vi.useFakeTimers()
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
      onAnswer,
      true,
      true
    )

    pressKey({ key: '1' })
    pressKey({ key: '3' })
    pressKey({ key: '1' })
    passAutoAdvanceBeat()
    expect(onAnswer).not.toHaveBeenCalled()
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [2], other: '' }])
  })

  it('keeps the keyboard on the card when the focused option is replaced by the next question', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    render(indentThenFruits, vi.fn(), true, true)
    const spaces = container.querySelectorAll<HTMLElement>('button[aria-pressed]')[1]!

    act(() => spaces.focus())
    clickOption('Spaces')
    passAutoAdvanceBeat()

    expect(cardTitle()).toBe('Which fruit?')
    expect(document.activeElement).toBe(container.querySelector('button[aria-pressed]'))
  })

  it('puts the keyboard in the answer field when typing is the only answer', () => {
    render(
      { questions: [{ question: 'Type your answer:', multiSelect: false, options: [] }] },
      vi.fn(),
      true,
      true
    )

    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it('moves the keyboard into the answer field when a number key advances to a typed-only question', () => {
    vi.useFakeTimers()
    container.setAttribute('data-native-chat-root', 'true')
    render(
      {
        questions: [
          tabsOrSpaces.questions[0]!,
          { question: 'Anything else?', multiSelect: false, options: [] }
        ]
      },
      vi.fn(),
      true,
      true
    )

    pressKey({ key: '1' }, document.activeElement!)
    passAutoAdvanceBeat()

    expect(cardTitle()).toBe('Anything else?')
    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it('picks from a number key pressed anywhere inside its own chat pane', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    container.setAttribute('data-native-chat-root', 'true')
    render(tabsOrSpaces, onAnswer, true, true)

    pressKey({ key: '2' }, container.querySelector('button[aria-pressed]')!)
    passAutoAdvanceBeat()

    expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1], other: '' }])
  })

  it.each<{
    when: string
    shouldFocus?: boolean
    from?: 'answer-field' | 'outside-pane'
    init: KeyboardEventInit
  }>([
    { when: 'typed into the answer field', from: 'answer-field', init: { key: '1' } },
    { when: 'pressed on another surface', from: 'outside-pane', init: { key: '1' } },
    { when: 'pressed while another pane has the keyboard', shouldFocus: false, init: { key: '1' } },
    { when: 'past the last option', init: { key: '3' } },
    { when: 'arrow pressed on another surface', from: 'outside-pane', init: { key: 'ArrowDown' } },
    { when: 'arrow held with a modifier', init: { key: 'ArrowDown', shiftKey: true } },
    { when: 'held with a modifier', init: { key: '1', metaKey: true } }
  ])('leaves a number key alone when $when', ({ shouldFocus = true, from, init }) => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    container.setAttribute('data-native-chat-root', 'true')
    render(tabsOrSpaces, onAnswer, true, shouldFocus)
    const outside = document.body.appendChild(document.createElement('button'))

    const event = pressKey(
      init,
      from === 'answer-field'
        ? container.querySelector('input')!
        : from === 'outside-pane'
          ? outside
          : document.body
    )
    passAutoAdvanceBeat()
    outside.remove()

    expect(event.defaultPrevented).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
