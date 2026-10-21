// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

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
        message={{ id: 'r-1', role: 'reasoning', timestamp: STARTED, state: 'completed' }}
        markdown={'\n\nInspecting the request\nFull reasoning'}
      />
    )
    expect(screen.getByRole('button', { name: 'Reasoning: Thought' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    // The same category glyph slot a tool row leads with, hidden from the accessible name.
    const glyph = screen.getByRole('button').querySelector('svg.lucide-brain')
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
  })

  it('leads with the shared vocabulary brain, drawn exactly as a tool row draws a glyph', () => {
    const { container } = render(
      <NativeChatToolRunIcon iconName="brain" className="text-chat-foreground-faint" />
    )
    const shared = container.innerHTML
    cleanup()
    render(
      <NativeChatReasoningRow
        message={{ id: 'r-1', role: 'reasoning', timestamp: STARTED, state: 'completed' }}
        markdown="Inspecting"
      />
    )
    expect(
      screen.getByRole('button').querySelector('svg.lucide-brain')?.parentElement?.outerHTML
    ).toBe(shared)
  })

  it('hides its chevron only where hover can reveal it, and shows it on keyboard focus and once open', () => {
    render(
      <NativeChatReasoningRow
        message={{ id: 'r-1', role: 'reasoning', timestamp: STARTED, state: 'completed' }}
        markdown="Inspecting"
      />
    )
    // An SVG's `className` is an `SVGAnimatedString`, so read the attribute.
    const chevron = screen.getByRole('button').querySelector('svg.lucide-chevron-right')
    const classes = (chevron?.getAttribute('class') ?? '').split(' ')
    // Touch has no hover, so an ungated `opacity-0` would hide it there for good.
    expect(classes).not.toContain('opacity-0')
    expect(classes).toEqual(
      expect.arrayContaining([
        'can-hover:opacity-0',
        'group-hover/reasoning:opacity-100',
        'group-focus-visible/reasoning:opacity-100',
        'group-data-[state=open]/reasoning:opacity-100'
      ])
    )
  })

  it('expands through a native button and keeps disclosure state through revisions', () => {
    const message = {
      id: 'r-1',
      role: 'reasoning' as const,
      timestamp: STARTED,
      state: 'completed' as const
    }
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

  it('keeps its disclosure under the block key, so a remount (or the live line) finds it open', () => {
    const Transcript = ({ children }: { children: React.ReactNode }) => {
      const disclosures = useNativeChatDisclosures()
      return (
        <NativeChatDisclosureContext.Provider value={disclosures}>
          {children}
        </NativeChatDisclosureContext.Provider>
      )
    }
    const row = (
      <NativeChatReasoningRow
        message={{ id: 'r-1', role: 'reasoning', timestamp: STARTED, state: 'completed' }}
        markdown="Inspecting"
      />
    )
    const { rerender } = render(<Transcript>{row}</Transcript>)
    fireEvent.click(screen.getByRole('button'))
    // Windowed out, then back.
    rerender(<Transcript>{null}</Transcript>)
    rerender(<Transcript>{row}</Transcript>)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('markdown')).toHaveTextContent('Inspecting')
  })

  it.each(['', ' \n\t'])('draws nothing for blank reasoning %j', (markdown) => {
    const { container } = render(
      <NativeChatReasoningRow
        message={{ id: 'r-1', role: 'reasoning', timestamp: STARTED, state: 'running' }}
        markdown={markdown}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the reasoning headline', () => {
  const headline = (
    message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>,
    turnIsWorking = false
  ) => {
    render(
      <NativeChatReasoningRow
        message={{ id: 'r-1', role: 'reasoning', ...message }}
        markdown="Reasoned"
        turnIsWorking={turnIsWorking}
      />
    )
    return screen.queryByRole('button')?.textContent ?? null
  }

  // The live line hides the one block it discloses; any other open row draws, claiming no end.
  it('reads Reasoning while the row is open and its turn or subagent is running', () => {
    expect(headline({ timestamp: STARTED, state: 'running' }, true)).toBe('Reasoning')
  })

  it('reads Thought for N s once it closes, while the turn goes on working', () => {
    expect(
      headline({ timestamp: STARTED, state: 'completed', completedAt: STARTED + 12_000 }, true)
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

  it('claims no duration it never saw, and draws an open row in a settled turn as Thought', () => {
    expect(headline({ timestamp: STARTED, state: 'completed' })).toBe('Reasoning: Thought')
    cleanup()
    expect(headline({ timestamp: STARTED, state: 'running' })).toBe('Reasoning: Thought')
  })

  it('stays neutral for a row from a host that kept no lifecycle', () => {
    expect(headline({ timestamp: STARTED }, true)).toBe('Reasoning')
  })

  it('draws through the message row while open, and reads its span once it closes', () => {
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
    expect(screen.getByRole('button')).toHaveTextContent('Reasoning')
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
