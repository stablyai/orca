// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

afterEach(cleanup)

const QUESTION = 'What would you like me to do next in this repo?'
const ASK_INPUT = { questions: [{ question: QUESTION }] }

function askBlocks(state: 'running' | 'completed'): NativeChatBlock[] {
  return [{ type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state }]
}

/** Lays every element out wider than its box, as a long question is on its line. */
function clipEveryLine(): () => void {
  const originals = ['scrollWidth', 'clientWidth'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => 400
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 100
  })
  return () => {
    for (const [name, original] of originals) {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, name, original)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, name)
      }
    }
  }
}

function DisclosureHarness({ mounted }: { mounted: boolean }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {mounted ? (
        <NativeChatToolRun
          blocks={askBlocks('completed')}
          expandSignal
          activeTurnIsWorking={false}
          disclosureId="message-1"
        />
      ) : null}
    </NativeChatDisclosureContext.Provider>
  )
}

describe('NativeChatToolRun awaiting-input row', () => {
  it('does not revive stale tool state after a turn stops', () => {
    render(
      <NativeChatToolRun blocks={askBlocks('running')} expandSignal activeTurnIsWorking={false} />
    )
    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.getByText('Asked:')).toBeInTheDocument()
  })

  it('keeps a pending question visible alongside another active tool', () => {
    render(
      <NativeChatToolRun
        blocks={[
          ...askBlocks('running'),
          { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'running' }
        ]}
        expandSignal
        activeTurnIsWorking
      />
    )
    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    expect(screen.getByText('Reading 1 file')).toBeInTheDocument()
    expect(screen.getByText('Read a.ts')).toBeInTheDocument()
  })

  it('preserves errors from failed question calls', () => {
    render(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'failed' },
          { type: 'tool-result', output: 'Question rejected', isError: true }
        ]}
        expandSignal
        activeTurnIsWorking={false}
      />
    )
    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.queryByText('Asked:')).toBeNull()
    expect(screen.getAllByText('Question rejected').length).toBeGreaterThan(0)
  })
  it('replaces a running ask call with the awaiting row', () => {
    const { container } = render(
      <NativeChatToolRun blocks={askBlocks('running')} expandSignal activeTurnIsWorking />
    )

    expect(screen.getByText('Awaiting user input:')).toHaveClass(
      'animate-pulse',
      'motion-reduce:animate-none'
    )
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    expect(container.querySelector('.lucide-message-square-more')).toBeInTheDocument()
    // The raw call and its payload are exactly what this row exists to replace.
    expect(screen.queryByText(/Running AskUserQuestion/)).toBeNull()
    expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
  })

  it('reports a settled ask without the pulse or a tool-count header', () => {
    const { container } = render(
      <NativeChatToolRun blocks={askBlocks('completed')} expandSignal activeTurnIsWorking={false} />
    )

    expect(screen.getByText('Asked:')).not.toHaveClass('animate-pulse')
    expect(screen.getByText(QUESTION)).toBeInTheDocument()
    // A run that is only the ask has no work left to head, so it draws no header.
    expect(container.querySelector('[data-native-chat-tool-run-state]')).toBeNull()
  })

  it('leaves a question that fits on its line as plain text', () => {
    const { container } = render(
      <NativeChatToolRun blocks={askBlocks('completed')} expandSignal activeTurnIsWorking={false} />
    )
    expect(screen.getByText(QUESTION)).toHaveClass('truncate')
    expect(container.querySelector('button')).toBeNull()
  })

  it('opens a clipped question below the toggle and folds it back', () => {
    const restore = clipEveryLine()
    try {
      render(
        <NativeChatToolRun
          blocks={askBlocks('completed')}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      const toggle = screen.getByRole('button', { name: /Asked:/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const full = screen.getByText(QUESTION)
      expect(full).not.toHaveClass('truncate')
      // Outside the button, so it selects like prose and a click in it keeps it open.
      expect(full.closest('button')).toBeNull()
      fireEvent.click(full)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByText(QUESTION)).toHaveClass('truncate')
    } finally {
      restore()
    }
  })

  it('keeps an opened question open when the windowed row remounts', () => {
    const restore = clipEveryLine()
    try {
      const { rerender } = render(<DisclosureHarness mounted />)
      fireEvent.click(screen.getByRole('button', { name: /Asked:/ }))

      rerender(<DisclosureHarness mounted={false} />)
      expect(screen.queryByText(QUESTION)).toBeNull()
      rerender(<DisclosureHarness mounted />)

      const toggle = screen.getByRole('button', { name: /Asked:/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText(QUESTION).closest('button')).toBeNull()

      // Folding it keeps the same control, so keyboard focus is not dropped.
      toggle.focus()
      fireEvent.click(toggle)
      expect(document.activeElement).toBe(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
    } finally {
      restore()
    }
  })

  it('offers no expansion when the row names only a question count', () => {
    const restore = clipEveryLine()
    try {
      const input = { questions: [{ question: 'First?' }, { question: 'Second?' }] }
      render(
        <NativeChatToolRun
          blocks={[{ type: 'tool-call', name: 'AskUserQuestion', input, state: 'completed' }]}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      expect(screen.getByText('2 questions')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Asked:/ })).toBeNull()
    } finally {
      restore()
    }
  })

  it('counts only the work that ran in the header beside the ask', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
      { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'running' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking />)

    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    // One call ran; being asked a question is not work to summarize. The agent
    // is blocked on the reader, so the run reads settled, not in progress.
    expect(screen.getByText('Read 1 file')).toBeInTheDocument()
    expect(screen.queryByText('Reading 1 file')).toBeNull()
  })

  it('draws the row from the tool name when the payload names no question', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'request_user_input', input: {}, state: 'running' }]}
        expandSignal
        activeTurnIsWorking
      />
    )

    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    expect(screen.queryByText(/request_user_input/)).toBeNull()
  })
})
