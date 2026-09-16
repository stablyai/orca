// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

const QUESTION = 'What would you like me to do next in this repo?'
const ASK_INPUT = { questions: [{ question: QUESTION }] }

function askBlocks(state: 'running' | 'completed'): NativeChatBlock[] {
  return [{ type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state }]
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
    expect(screen.getByText(/Running Read/)).toBeInTheDocument()
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
    // A run that is only the ask has no work left to head, so it draws no `1×`.
    expect(container.querySelector('button')).toBeNull()
  })

  it('counts only the work that ran in the header beside the ask', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
      { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'running' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking />)

    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    // One call ran; being asked a question is not work to count.
    expect(screen.getByText('1×')).toBeInTheDocument()
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
