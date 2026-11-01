// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'

const openAgentMessageSender = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender }))

afterEach(() => {
  cleanup()
  openAgentMessageSender.mockClear()
})

const CODER = { address: 'term_coder', terminalHandle: 'term_coder', orcaSessionId: null }

function from(senders: { address: string; name: string | null }[]): AgentMessageSource {
  return {
    kind: 'agent',
    senders: senders.map(({ address, name }) => ({
      party: { address, terminalHandle: address, orcaSessionId: null },
      name
    })),
    orchestration: null
  }
}

function renderUserMessage(source?: AgentMessageSource, worktreeId: string | null = 'wt-chat') {
  const message: NativeChatMessage = {
    id: 'message',
    role: 'user',
    timestamp: 0,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
    ...(source ? { from: source } : {})
  }
  return render(
    <MessageRow
      message={message}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      runtimeContext={
        worktreeId
          ? { target: { kind: 'local' as const }, worktreeId, worktreePath: '/repo' }
          : undefined
      }
    />
  )
}

describe("another agent's message in the transcript", () => {
  it("opens the sender from its name, on the chat's own host, with the message it sent", () => {
    const source = from([{ address: CODER.address, name: 'Coder' }])
    renderUserMessage(source)
    fireEvent.click(screen.getByRole('button', { name: 'Coder' }))
    expect(openAgentMessageSender).toHaveBeenCalledWith(source, source.senders[0], 'wt-chat', {
      kind: 'local'
    })
  })
})

describe("another agent's queued card", () => {
  function renderCard(source: AgentMessageSource, chatWorktreeId: string | null = 'wt-chat') {
    return render(
      <NativeChatQueuedMessageCard
        card={{
          messageId: 'card',
          position: 1,
          text: 'You have 1 orchestration message.',
          state: 'waiting',
          hold: 'turn',
          from: source
        }}
        chatWorktreeId={chatWorktreeId}
        showsSteerShortcut={false}
        onSteer={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        agentWorking
      />
    )
  }

  it('names who it is from, and opens the sender from its name as the transcript row does', () => {
    const source = from([
      { address: 'term_a', name: 'Coder' },
      { address: 'term_b', name: null }
    ])
    const { container } = renderCard(source)
    expect(container.textContent).toContain('FromCoder,an agent')
    fireEvent.click(screen.getByRole('button', { name: 'Coder' }))
    expect(openAgentMessageSender).toHaveBeenCalledWith(source, source.senders[0], 'wt-chat')
  })
})
