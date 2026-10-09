// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../../shared/agent-session-message-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import { TooltipProvider } from '@/components/ui/tooltip'

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
        worktreeId ? { settings: null, worktreeId, worktreePath: '/repo' } : undefined
      }
    />
  )
}

describe("another agent's message in the transcript", () => {
  it('reads as a left-aligned message from its sender, not as the person’s bubble', () => {
    const { container } = renderUserMessage(from([{ address: CODER.address, name: 'Coder' }]))
    expect(screen.getByText('Message from')).toBeInTheDocument()
    const row = container.firstElementChild
    expect(row).toHaveClass('items-start')
    expect(row).not.toHaveClass('items-end')
    expect(container.querySelector('.bg-chat-user-surface')).toBeNull()
    expect(screen.getByText('You have 1 orchestration message.')).toBeInTheDocument()
  })

  it("opens the sender from its name, on the chat's own host, with the message it sent", () => {
    const source = from([{ address: CODER.address, name: 'Coder' }])
    renderUserMessage(source)
    fireEvent.click(screen.getByRole('button', { name: 'Coder' }))
    expect(openAgentMessageSender).toHaveBeenCalledWith(source, source.senders[0], 'wt-chat')
  })

  it('separates the names as the queued card does, and keeps two same-named senders two', () => {
    const { container } = renderUserMessage(
      from([
        { address: 'term_a', name: 'Codex' },
        { address: 'term_b', name: 'Codex' }
      ])
    )
    expect(screen.getAllByRole('button', { name: 'Codex' })).toHaveLength(2)
    expect(container.textContent).toContain('Message fromCodex,Codex')
  })

  it('names each sender, an unnamed one as an agent, and counts the rest', () => {
    renderUserMessage(
      from([
        { address: 'term_a', name: 'A' },
        { address: 'term_b', name: null },
        { address: 'term_c', name: 'C' },
        { address: 'term_d', name: 'D' }
      ])
    )
    expect(screen.getByRole('button', { name: 'A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'an agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'C' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'D' })).not.toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('shows a sender on another host as plain text, since this host cannot open it', () => {
    renderUserMessage(
      from([
        { address: 'dispatch:d1', name: 'Port the parser' },
        { address: CODER.address, name: 'Coder' }
      ])
    )
    expect(screen.getByText('Port the parser')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Port the parser' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Coder' })).toBeInTheDocument()
  })

  it('shows the name as plain text where there is no chat to open it from', () => {
    renderUserMessage(from([{ address: CODER.address, name: 'Coder' }]), null)
    expect(screen.getByText('Coder')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Coder' })).not.toBeInTheDocument()
  })

  it("leaves the person's own message as their right-aligned bubble", () => {
    const { container } = renderUserMessage()
    expect(screen.queryByText('Message from')).not.toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('items-end')
    expect(container.querySelector('.bg-chat-user-surface')).not.toBeNull()
  })
})

describe("another agent's queued card", () => {
  function renderCard(source: AgentMessageSource, chatWorktreeId: string | null = 'wt-chat') {
    return render(
      <TooltipProvider>
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
          onTurnOffQueueing={vi.fn()}
        />
      </TooltipProvider>
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

  it('counts in "+N" only the senders it does not name, same-named ones included', () => {
    renderCard(
      from(['term_a', 'term_b', 'term_c', 'term_d'].map((address) => ({ address, name: 'Codex' })))
    )
    expect(screen.getAllByRole('button', { name: 'Codex' })).toHaveLength(3)
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('shows the name as plain text where there is no chat to open it from', () => {
    renderCard(from([{ address: 'term_a', name: 'Coder' }]), null)
    expect(screen.getByText('Coder')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Coder' })).not.toBeInTheDocument()
  })
})
