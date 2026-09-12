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

function render(
  prompt: AskPrompt,
  onAnswer: (s: AskAnswerSelection[]) => void,
  allowOther: boolean | readonly boolean[] = true
): void {
  act(() => {
    root.render(
      <NativeChatQuestionCard
        prompt={prompt}
        onAnswer={onAnswer}
        onCancel={() => {}}
        allowOther={allowOther}
      />
    )
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

/** The trailing Submit/Next/Skip control, whatever it currently reads. */
function actionButton(): HTMLButtonElement {
  const row = container.querySelector('input')!.parentElement!
  const button = row.querySelector('button')
  if (!button) {
    throw new Error('trailing action button not found')
  }
  return button
}

function typeAnswer(text: string): void {
  const input = container.querySelector('input')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
    // strings are present — not that the two-column layout renders, that the
    // preview spans the rows, or that anything is top-aligned.
    render(previewPrompt, vi.fn())

    const optionsGrid = previewPanel()!.parentElement!
    expect(optionsGrid.className).toContain('@2xl/question:grid-cols-2')
    expect(optionsGrid.className).toContain(
      '@2xl/question:[&>[data-slot=question-preview]]:col-start-2'
    )
    expect(optionsGrid.className).toContain(
      '@2xl/question:[&>[data-slot=question-preview]]:row-span-full'
    )
    expect(optionsGrid.className).toContain('@2xl/question:grid-rows-(--question-option-rows)')
    expect(optionsGrid.closest('.\\@container\\/question')).not.toBeNull()
  })

  it('declares one explicit row track per option so the preview can span them', () => {
    // `row-span-full` resolves against explicit grid lines, so the track count
    // must follow the option count. The value is a real inline style, so this
    // part is behavior — only its container-query gating is untestable here.
    render(previewPrompt, vi.fn())
    expect(previewPanel()!.parentElement!.style.getPropertyValue('--question-option-rows')).toBe(
      'repeat(2, min-content)'
    )

    render(
      {
        questions: [
          {
            question: 'Pick',
            multiSelect: false,
            options: [
              { label: 'A', hasPreview: true, preview: 'a' },
              { label: 'B' },
              { label: 'C' }
            ]
          }
        ]
      },
      vi.fn()
    )
    expect(previewPanel()!.parentElement!.style.getPropertyValue('--question-option-rows')).toBe(
      'repeat(3, min-content)'
    )
  })

  it('keeps option rows sized to their own content', () => {
    // Guards the hover jiggle: rows must not stretch to the preview's height.
    render(previewPrompt, vi.fn())

    expect(previewPanel()!.parentElement!.className).toContain('auto-rows-min')
  })

  it('frames the preview well only beside the option list, not stacked under it', () => {
    // Class-string level: happy-dom does not evaluate container queries, so this
    // asserts the frame is gated to the wide variant — not that it renders.
    render(previewPrompt, vi.fn())

    const well = previewPanel()!.firstElementChild!
    expect(well.className).toContain('@2xl/question:rounded-md')
    expect(well.className).toContain('@2xl/question:border')
    // Unprefixed frame classes would draw the well as a card in stacked mode.
    expect(well.className).not.toMatch(/(^|\s)rounded-md(\s|$)/)
    expect(well.className).not.toMatch(/(^|\s)border(\s|$)/)
    expect(well.className).toContain('bg-muted/40')
  })

  it('lifts the split-layout well out of flow so preview length cannot resize the grid', () => {
    // Class-string level. In flow, a taller preview grows its track and the card
    // resizes as the highlight moves between options of differing lengths.
    render(previewPrompt, vi.fn())

    const panel = previewPanel()!
    const well = panel.firstElementChild!
    expect(panel.className).toContain('@2xl/question:relative')
    expect(well.className).toContain('@2xl/question:absolute')
    expect(well.className).toContain('@2xl/question:inset-y-2.5')
    // Stacked, the well stays in flow so it can push the rows below it down.
    expect(well.className).not.toMatch(/(^|\s)absolute(\s|$)/)
  })

  it('indents the stacked preview to the option label column and resets it when split', () => {
    // Class-string level. pl-13 is the row's border + padding + badge + gap, so
    // the well lines up with the label rather than the number badge.
    render(previewPrompt, vi.fn())

    expect(previewPanel()!.className).toContain('pl-13')
    expect(previewPanel()!.className).toContain('@2xl/question:pl-3.5')
  })

  it('gives the preview no disclosure affordance', () => {
    // The preview follows hover, so a control inviting a click would do nothing.
    render(previewPrompt, vi.fn())

    const panel = previewPanel()!
    expect(panel.querySelector('button, a, [role="button"], summary, details')).toBeNull()
    expect(panel.hasAttribute('aria-expanded')).toBe(false)
  })

  it('marks the highlighted row with the affinity border that ties it to the preview', () => {
    render(previewPrompt, vi.fn())

    expect(optionRow('Tabs').className).toContain('border-l-ring')
    expect(optionRow('Spaces').className).not.toContain('border-l-ring')

    hoverOption('Spaces')

    expect(optionRow('Spaces').className).toContain('border-l-ring')
    expect(optionRow('Tabs').className).not.toContain('border-l-ring')
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

  it('names the free-form row for what the text will do', () => {
    // With a pick the text rides along as that option's note; without one it has
    // no selector representation and leaves as a chat message.
    render(previewPrompt, vi.fn())
    expect(container.querySelector('input')!.placeholder).toBe(
      'Answer in your own words — sends as a chat message'
    )

    clickOption('Spaces')
    expect(container.querySelector('input')!.placeholder).toBe('Add a note (optional)')

    render(tabsOrSpaces, vi.fn())
    expect(container.querySelector('input')!.placeholder).toBe('Type your answer')
  })

  it('submits text with no pick rather than blocking on one', () => {
    // Routing sends it to chat; the card's job is only to hand it over.
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    typeAnswer('none of these, actually')

    const action = actionButton()
    expect(action.disabled).toBe(false)
    expect(action.textContent?.trim()).toBe('Submit')

    click(action, 'Submit')
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'none of these, actually' }])
  })

  it('submits text with no pick from the Enter key too', () => {
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    typeAnswer('none of these, actually')
    const input = container.querySelector('input')!
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'none of these, actually' }])
  })

  it('submits a picked option together with its note', () => {
    // The delivery layer selects the row then annotates it, so the card must
    // carry both halves through rather than dropping either.
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    clickOption('Spaces')
    typeAnswer('but only in JS')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: 'but only in JS' }])
  })

  it('does not treat a hovered option as a pick', () => {
    // Hover only drives which preview shows, so the text is still unattached.
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    hoverOption('Spaces')
    typeAnswer('my typed answer')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([{ indices: [], other: 'my typed answer' }])
  })

  it('keeps typed text when focus moves from an option row to the free-form input', () => {
    const onAnswer = vi.fn()
    render(previewPrompt, onAnswer)

    clickOption('Spaces')
    focusOption('Tabs')
    const input = container.querySelector('input')!
    act(() => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    typeAnswer('typed after focus')
    clickAction('Submit')

    // Focus moving across rows must not disturb the pick or the typed note.
    expect(onAnswer).toHaveBeenCalledWith([{ indices: [1], other: 'typed after focus' }])
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

  it('submits typed text per question in a multi-question preview prompt', () => {
    const onAnswer = vi.fn()
    render(
      {
        questions: [
          {
            question: 'First?',
            multiSelect: false,
            options: [{ label: 'A', hasPreview: true, preview: 'a' }]
          },
          {
            question: 'Second?',
            multiSelect: false,
            options: [{ label: 'B', hasPreview: true, preview: 'b' }]
          }
        ]
      },
      onAnswer
    )

    clickOption('A')
    typeAnswer('first answer')
    clickAction('Next')
    clickOption('B')
    typeAnswer('second answer')
    clickAction('Submit')

    expect(onAnswer).toHaveBeenCalledWith([
      { indices: [0], other: 'first answer' },
      { indices: [0], other: 'second answer' }
    ])
  })
})
