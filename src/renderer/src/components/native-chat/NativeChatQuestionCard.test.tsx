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

function optionRow(label: string): Element {
  const row = [...container.querySelectorAll('button[aria-pressed]')].find((b) =>
    b.textContent?.includes(label)
  )
  if (!row) {
    throw new Error(`option not found: ${label}`)
  }
  return row
}

function hoverOption(label: string): void {
  const row = optionRow(label)
  act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
}

function focusOption(label: string): void {
  const row = optionRow(label)
  act(() => row.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
}

function clickAction(text: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text
  )
  click(button, text)
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

const previewPrompt: AskPrompt = {
  questions: [
    {
      question: 'Do you prefer tabs or spaces?',
      multiSelect: false,
      options: [
        { label: 'Tabs', preview: '\tindented' },
        { label: 'Spaces', preview: '    indented' }
      ]
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

  it('renders no preview panel when no option carries one', () => {
    render(tabsOrSpaces, vi.fn())

    expect(container.querySelector('pre')).toBeNull()
  })

  it('shows the first option’s preview before anything is picked', () => {
    render(previewPrompt, vi.fn())

    expect(container.querySelector('pre')?.textContent).toBe('\tindented')
  })

  it('switches the preview to the option the pointer highlights', () => {
    render(previewPrompt, vi.fn())

    hoverOption('Spaces')

    expect(container.querySelector('pre')?.textContent).toBe('    indented')
  })

  it('switches the preview to the option keyboard focus reaches', () => {
    render(previewPrompt, vi.fn())

    focusOption('Spaces')

    expect(container.querySelector('pre')?.textContent).toBe('    indented')
  })

  it('previews the picked option and still delivers its index', () => {
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    clickOption('Spaces')
    expect(container.querySelector('pre')?.textContent).toBe('    indented')

    clickAction('Submit')
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })

  it('reports a missing preview for an option that has none', () => {
    render(
      {
        questions: [
          {
            question: 'Pick',
            multiSelect: false,
            options: [{ label: 'Snippet', preview: 'const x = 1' }, { label: 'Bare' }]
          }
        ]
      },
      vi.fn()
    )

    hoverOption('Bare')

    expect(container.querySelector('pre')).toBeNull()
    expect(container.textContent).toContain('no preview')
  })

  it('keeps the preview scoped to the focused question in a multi-question prompt', () => {
    render(
      {
        questions: [
          {
            question: 'First?',
            multiSelect: false,
            options: [{ label: 'A', preview: 'first-preview' }]
          },
          {
            question: 'Second?',
            multiSelect: false,
            options: [{ label: 'B', preview: 'second-preview' }]
          }
        ]
      },
      vi.fn()
    )

    expect(container.querySelector('pre')?.textContent).toBe('first-preview')

    clickAction('Skip')

    expect(container.querySelector('pre')?.textContent).toBe('second-preview')
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
})
