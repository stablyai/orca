// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { MessageRow } from './NativeChatMessageRow'

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const STARTED = 100_000

describe('reasoning disclosure', () => {
  it('starts collapsed without mounting markdown', () => {
    render(
      <NativeChatReasoningRow
        message={{ timestamp: STARTED, state: 'completed' }}
        markdown={'\n\nInspecting the request\nFull reasoning'}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning: Thought' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('expands through a native button and keeps disclosure state through revisions', () => {
    const message = { timestamp: STARTED, state: 'completed' as const }
    const { rerender } = render(<NativeChatReasoningRow message={message} markdown="Inspecting" />)
    const trigger = screen.getByRole('button')
    expect(trigger.tagName).toBe('BUTTON')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('Inspecting')
    rerender(<NativeChatReasoningRow message={message} markdown={'Inspecting\nMore'} />)
    expect(screen.getByRole('button')).toBe(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('More')
    // Collapsed again by the user, it stays collapsed through the next revision.
    fireEvent.click(trigger)
    rerender(<NativeChatReasoningRow message={message} markdown={'Inspecting\nFinal'} />)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it.each(['', ' \n\t'])('draws nothing for blank reasoning %j', (markdown) => {
    const { container } = render(
      <NativeChatReasoningRow
        message={{ timestamp: STARTED, state: 'running' }}
        markdown={markdown}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the reasoning headline', () => {
  const headline = (message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>) => {
    render(<NativeChatReasoningRow message={message} markdown="Reasoned" />)
    return screen.queryByRole('button')?.textContent ?? null
  }

  it('reads Thought for N s once it closes', () => {
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 12_000 })
    ).toContain('Thought for 12s')
  })

  it('measures the span the host saw, at least one second', () => {
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 65_000 })
    ).toContain('Thought for 1m 5s')
    cleanup()
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 300 })
    ).toContain('Thought for 1s')
  })

  it('claims no duration it never saw', () => {
    expect(headline({ timestamp: STARTED, state: 'completed' })).toBe('Reasoning: Thought')
  })

  it('reads neutral, never past tense, while the row has not ended', () => {
    expect(headline({ timestamp: STARTED, state: 'running' })).toBe('Reasoning')
  })

  it('stays neutral for a row from a host that kept no lifecycle', () => {
    expect(headline({ timestamp: STARTED })).toBe('Reasoning')
  })

  it('draws through the message row, neutral until it closes', () => {
    const message: NativeChatMessage = {
      id: 'reasoning-1',
      role: 'reasoning',
      source: 'transcript',
      timestamp: STARTED,
      state: 'running',
      blocks: [{ type: 'text', text: 'Inspecting the request\nFull reasoning' }]
    }
    const { rerender } = render(
      <MessageRow
        message={message}
        activeTurnIsWorking
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    // Hiding a row the host reports open is the transcript's call, not the row's.
    expect(screen.getByRole('button')).toHaveTextContent(/^Reasoning$/)
    rerender(
      <MessageRow
        message={{ ...message, state: 'completed', completedAt: STARTED + 3_000 }}
        activeTurnIsWorking
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 3s')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('markdown')).toHaveTextContent('Full reasoning')
  })
})
