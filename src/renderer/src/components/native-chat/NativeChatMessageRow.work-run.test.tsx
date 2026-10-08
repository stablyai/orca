// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'

afterEach(() => {
  cleanup()
})

function thought(id: string, body: string): NativeChatMessage {
  return {
    id,
    role: 'reasoning',
    blocks: [{ type: 'text', text: body }],
    timestamp: 1000,
    completedAt: 4000,
    state: 'completed',
    source: 'transcript'
  }
}

function command(id: string, cmd: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      { type: 'tool-call', name: 'Bash', input: { command: cmd }, state: 'completed', callId: id },
      { type: 'tool-result', output: 'ok', callId: id }
    ],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('message row drawing a work run', () => {
  it('speaks for its calls alone, and reads its thoughts in order once opened', () => {
    const first = thought('r1', 'Check the log first.')
    const { container } = render(
      <MessageRow
        message={first}
        workRun={[
          first,
          command('a', 'ls logs'),
          thought('r2', 'Now search it.'),
          command('b', 'rg error logs'),
          thought('r3', 'That settles it.')
        ]}
        expandSignal={false}
        activeTurnIsWorking={false}
        onScrollMessageToTop={() => {}}
      />
    )
    const header = container.querySelector('button')!
    expect(header).toHaveTextContent('Ran 2 commands')
    expect(screen.queryByText(/Thought/)).not.toBeInTheDocument()

    fireEvent.click(header)
    const order = Array.from(
      container.querySelectorAll('button'),
      (button) => button.textContent ?? ''
    ).slice(1)
    const at = (pattern: RegExp) => order.findIndex((label) => pattern.test(label))
    expect(order.filter((label) => /Thought for 3s/.test(label))).toHaveLength(3)
    expect(at(/ls logs/)).toBeGreaterThan(at(/Thought for 3s/))
    expect(at(/rg error logs/)).toBeGreaterThan(at(/ls logs/))
    expect(order.at(-1)).toMatch(/Thought for 3s/)
  })

  it("draws a run headed by the agent's words under them", () => {
    const head: NativeChatMessage = {
      ...command('a', 'ls logs'),
      blocks: [{ type: 'text', text: 'Looking at the logs.' }, ...command('a', 'ls logs').blocks]
    }
    const { container } = render(
      <MessageRow
        message={head}
        workRun={[head, thought('r1', 'Now search it.'), command('b', 'rg error logs')]}
        expandSignal={false}
        activeTurnIsWorking={false}
        onScrollMessageToTop={() => {}}
      />
    )
    expect(screen.getByText('Looking at the logs.')).toBeInTheDocument()
    const header = container.querySelector('[data-native-chat-tool-run-state]')!
    expect(header).toHaveTextContent('Ran 2 commands')
    fireEvent.click(header)
    expect(screen.getByText(/Thought for 3s/)).toBeInTheDocument()
  })
})
