// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileChatView, type MobileChatMessage } from './MobileChatView'

afterEach(cleanup)

const messages: MobileChatMessage[] = [
  { id: 'm-1', role: 'user', content: 'Please fix the tunnel' },
  { id: 'm-2', role: 'assistant', content: 'I will inspect the logs.' }
]

describe('MobileChatView', () => {
  it('renders pending approval and sends an approve decision', () => {
    const onResolveInteraction = vi.fn()
    render(
      <MobileChatView
        title="Deploy Task"
        messages={messages}
        pendingInteraction={{
          interactionId: 'act-99',
          revision: 2,
          command: 'rm -rf ./tmp/build-cache',
          dangerLevel: 'high'
        }}
        onSendPrompt={vi.fn()}
        onResolveInteraction={onResolveInteraction}
        onBack={vi.fn()}
      />
    )

    expect(screen.getByText('Please fix the tunnel')).toBeDefined()
    expect(screen.getByText(/rm -rf \.\/tmp\/build-cache/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /允许执行/i }))
    expect(onResolveInteraction).toHaveBeenCalledWith('act-99', 'approve')
  })

  it('sends a trimmed prompt and clears the composer', () => {
    const onSendPrompt = vi.fn()
    render(
      <MobileChatView
        title="Deploy Task"
        messages={[]}
        onSendPrompt={onSendPrompt}
        onResolveInteraction={vi.fn()}
        onBack={vi.fn()}
      />
    )

    const input = screen.getByPlaceholderText('Send an instruction to the agent…')
    fireEvent.change(input, { target: { value: '  continue  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    expect(onSendPrompt).toHaveBeenCalledWith('continue')
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('shows tool calls collapsed until opened', () => {
    render(
      <MobileChatView
        title="Deploy Task"
        messages={[
          {
            id: 'm-3',
            role: 'assistant',
            content: 'Running the tests.',
            tools: [{ name: 'Bash', input: 'pnpm test', output: 'ok', state: 'completed' }]
          }
        ]}
        onSendPrompt={vi.fn()}
        onResolveInteraction={vi.fn()}
        onBack={vi.fn()}
      />
    )

    expect(screen.getByText('Bash')).toBeDefined()
    expect(screen.queryByText('pnpm test')).toBeNull()
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByText('pnpm test')).toBeDefined()
    expect(screen.getByText('ok')).toBeDefined()
  })
})
