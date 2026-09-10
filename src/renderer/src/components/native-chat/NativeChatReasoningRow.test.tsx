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

describe('reasoning disclosure', () => {
  it('shows the unobserved-history fallback collapsed without mounting markdown', () => {
    render(<NativeChatReasoningRow markdown={'\n\nInspecting the request\nFull reasoning'} />)
    expect(
      screen.getByRole('button', { name: 'Reasoning: Thought for a few seconds' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).not.toHaveTextContent(/\d/)
  })

  it('expands through a native button and preserves disclosure state through revisions', () => {
    const { rerender } = render(<NativeChatReasoningRow markdown="Inspecting" />)
    const trigger = screen.getByRole('button')
    expect(trigger.tagName).toBe('BUTTON')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('Inspecting')
    rerender(<NativeChatReasoningRow markdown={'Inspecting the request\nMore reasoning'} />)
    expect(screen.getByRole('button')).toBe(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('More reasoning')
    fireEvent.click(trigger)
    rerender(<NativeChatReasoningRow markdown={'Inspecting the request\nFinal reasoning'} />)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it.each(['', ' \n\t'])('omits blank reasoning %j', (markdown) => {
    const { container } = render(<NativeChatReasoningRow markdown={markdown} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows Thinking while streaming and freezes the locally observed duration on settlement', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { rerender } = render(
      <NativeChatReasoningRow blockId="a" markdown="Inspecting" isStreaming />
    )
    expect(screen.getByRole('button')).toHaveTextContent('Thinking...')
    expect(screen.getByText('Thinking...')).toHaveClass('animate-pulse')
    now.mockReturnValue(105_000)
    rerender(<NativeChatReasoningRow blockId="a" markdown="Inspecting more" isStreaming />)
    now.mockReturnValue(112_000)
    rerender(<NativeChatReasoningRow blockId="a" markdown="Done" isStreaming={false} />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 12s')
    now.mockReturnValue(180_000)
    rerender(<NativeChatReasoningRow blockId="a" markdown="Done again" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 12s')
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    rerender(<NativeChatReasoningRow blockId="history" markdown="Replayed" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for a few seconds')
    expect(screen.getByRole('button')).not.toHaveTextContent(/\d/)
    rerender(<NativeChatReasoningRow blockId="b" markdown="New block" isStreaming />)
    now.mockReturnValue(245_000)
    rerender(<NativeChatReasoningRow blockId="b" markdown="New block done" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 1m 5s')
  })

  it('excludes later turn work after the block stops changing', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { rerender } = render(<NativeChatReasoningRow markdown="Starting" isStreaming />)
    now.mockReturnValue(22_000)
    rerender(<NativeChatReasoningRow markdown="Reasoning complete" isStreaming />)
    now.mockReturnValue(70_000)
    rerender(<NativeChatReasoningRow markdown="Reasoning complete" isStreaming />)
    expect(screen.getByRole('button')).toHaveTextContent('Thinking...')
    now.mockReturnValue(100_000)
    rerender(<NativeChatReasoningRow markdown="Reasoning complete" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 12s')
  })

  it('resets the clock when block identity changes without a streaming-state transition', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { rerender } = render(<NativeChatReasoningRow blockId="a" markdown="First" isStreaming />)
    now.mockReturnValue(30_000)
    rerender(<NativeChatReasoningRow blockId="b" markdown="Second" isStreaming />)
    now.mockReturnValue(33_000)
    rerender(<NativeChatReasoningRow blockId="b" markdown="Second done" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 3s')
  })

  it('never displays zero seconds for a briefly observed stream', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { rerender } = render(<NativeChatReasoningRow markdown="Brief" isStreaming />)
    rerender(<NativeChatReasoningRow markdown="Brief" />)
    expect(screen.getByRole('button')).toHaveTextContent('Thought for 1s')
  })

  it('uses the existing message prose pipeline for reasoning-role messages', () => {
    const message: NativeChatMessage = {
      id: 'reasoning-1',
      role: 'reasoning',
      source: 'transcript',
      timestamp: 1,
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
    expect(screen.getByRole('button')).toHaveTextContent('Thinking...')
    rerender(
      <MessageRow
        message={{ ...message, id: 'history', timestamp: 1 }}
        activeTurnIsWorking={false}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('Thought for a few seconds')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('markdown')).toHaveTextContent('Full reasoning')
  })
})
