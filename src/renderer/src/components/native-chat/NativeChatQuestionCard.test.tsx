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

function previewPanel(): Element | null {
  return container.querySelector('[data-slot="question-preview"]')
}

function previewText(): string {
  return previewPanel()?.textContent ?? ''
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
        { label: 'Tabs', hasPreview: true, preview: '```\n\ttabs-indent\n```' },
        { label: 'Spaces', hasPreview: true, preview: '```\n    spaces-indent\n```' }
      ]
    }
  ]
}

/** A single-option question whose preview is the given markdown source. */
const promptWithPreview = (preview: string): AskPrompt => ({
  questions: [
    {
      question: 'Pick',
      multiSelect: false,
      options: [{ label: 'Only', hasPreview: true, preview }]
    }
  ]
})

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

    expect(previewPanel()).toBeNull()
  })

  it('shows the first option’s preview before anything is picked', () => {
    render(previewPrompt, vi.fn())

    expect(previewText()).toContain('tabs-indent')
  })

  it('switches the preview to the option the pointer highlights', () => {
    render(previewPrompt, vi.fn())

    hoverOption('Spaces')

    expect(previewText()).toContain('spaces-indent')
  })

  it('switches the preview to the option keyboard focus reaches', () => {
    render(previewPrompt, vi.fn())

    focusOption('Spaces')

    expect(previewText()).toContain('spaces-indent')
  })

  it('previews the picked option and still delivers its index', () => {
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    clickOption('Spaces')
    expect(previewText()).toContain('spaces-indent')

    clickAction('Submit')
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: '' }])
  })

  it('renders a fenced block in the preview as code', () => {
    render(promptWithPreview('```ts\nconst x = 1\n```'), vi.fn())

    const code = previewPanel()?.querySelector('pre code')
    expect(code?.textContent).toContain('const x = 1')
  })

  it('renders emphasis in the preview as markup, not literal asterisks', () => {
    render(promptWithPreview('pick **this** one'), vi.fn())

    expect(previewPanel()?.querySelector('strong')?.textContent).toBe('this')
    expect(previewText()).not.toContain('**')
  })

  it('keeps the lines of a fenced multi-line snippet intact', () => {
    render(promptWithPreview('```\nfirst\n\tsecond\n```'), vi.fn())

    const code = previewPanel()?.querySelector('pre code')
    expect(code?.textContent).toBe('first\n\tsecond\n')
  })

  it('reports a missing preview for an option that has none', () => {
    render(
      {
        questions: [
          {
            question: 'Pick',
            multiSelect: false,
            options: [
              { label: 'Snippet', hasPreview: true, preview: 'const x = 1' },
              { label: 'Bare' }
            ]
          }
        ]
      },
      vi.fn()
    )

    hoverOption('Bare')

    expect(previewText()).toContain('no preview')
    expect(previewText()).not.toContain('const x = 1')
  })

  it('places the preview immediately after the option it belongs to', () => {
    render(previewPrompt, vi.fn())

    const optionsGrid = previewPanel()!.parentElement!
    const positionOf = (node: Element): number => [...optionsGrid.children].indexOf(node)

    expect(positionOf(previewPanel()!)).toBe(positionOf(optionRow('Tabs')) + 1)

    hoverOption('Spaces')

    expect(positionOf(previewPanel()!)).toBe(positionOf(optionRow('Spaces')) + 1)
  })

  it('keeps the preview a sibling of the option rows in one shared container', () => {
    // The split layout places the panel in a second grid column, which only
    // works while it shares a parent with the rows it sits beside.
    render(previewPrompt, vi.fn())

    const optionsGrid = previewPanel()!.parentElement
    expect(optionRow('Tabs').parentElement).toBe(optionsGrid)
    expect(optionRow('Spaces').parentElement).toBe(optionsGrid)
  })

  it('carries the container-query classes that drive the split layout', () => {
    // happy-dom does not evaluate container queries, so this asserts the class
    // strings are present — not that the two-column layout renders.
    render(previewPrompt, vi.fn())

    const optionsGrid = previewPanel()!.parentElement!
    expect(optionsGrid.className).toContain('@2xl/question:grid-cols-2')
    expect(optionsGrid.className).toContain(
      '@2xl/question:[&>[data-slot=question-preview]]:col-start-2'
    )
    expect(optionsGrid.className).toContain(
      '@2xl/question:[&>[data-slot=question-preview]]:row-start-1'
    )
    expect(optionsGrid.closest('.\\@container\\/question')).not.toBeNull()
  })

  it('keeps the preview scoped to the focused question in a multi-question prompt', () => {
    render(
      {
        questions: [
          {
            question: 'First?',
            multiSelect: false,
            options: [{ label: 'A', hasPreview: true, preview: 'first-preview' }]
          },
          {
            question: 'Second?',
            multiSelect: false,
            options: [{ label: 'B', hasPreview: true, preview: 'second-preview' }]
          }
        ]
      },
      vi.fn()
    )

    expect(previewText()).toContain('first-preview')

    clickAction('Skip')

    expect(previewText()).toContain('second-preview')
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
