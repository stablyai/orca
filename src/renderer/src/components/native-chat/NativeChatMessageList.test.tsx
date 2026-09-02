// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Selectable agent response.' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

describe('NativeChatMessageList assistant messages', () => {
  it('keeps prose selectable and places non-selectable controls after it', () => {
    render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const prose = screen.getByText('Selectable agent response.')
    const row = prose.closest('.group')
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    const controls = copyButton.parentElement

    expect(row).toHaveClass('select-text')
    expect(controls).toHaveClass('select-none', 'pointer-events-none', 'mt-1')
    expect(controls).not.toHaveClass('absolute')
    expect(prose.compareDocumentPosition(controls!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps a running tool live when transcript lifecycle metadata is absent', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-tool-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
    expect(screen.queryByText('1×')).toBeNull()
    expect(document.querySelector('.text-destructive')).toBeNull()
  })

  it('keeps bridge chats on the legacy activity chrome', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'bridge-tool',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
        showTurnStatus={false}
      />
    )

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
    expect(screen.queryByText('Running sleep 5')).toBeNull()
    expect(document.querySelectorAll('.animate-bounce')).toHaveLength(3)
  })

  it('keeps the current tool live when a stale completed lifecycle meets active hook state', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          transcriptLifecycle: { state: 'completed', turnId: 'old-turn', timestamp: 1 },
          messages: [
            {
              id: 'current-tool',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 2,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
  })

  it('shows a stable thinking status directly below the user message', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-thinking',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start the task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Start the task')
    const thinking = screen.getByText('Thinking')
    expect(user.compareDocumentPosition(thinking)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(thinking.parentElement).not.toHaveClass('border-b')
    expect(thinking.parentElement).toHaveClass('text-sm')
    expect(container.querySelector('.animate-bounce')).toBeNull()
    expect(thinking).toHaveClass('animate-pulse')
    expect(container.querySelectorAll('.size-1.5.animate-pulse')).toHaveLength(0)
  })

  it('places the thinking status directly after the latest user message', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Run the checks' }],
              timestamp: 1,
              source: 'transcript'
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'I am checking now.' }],
              timestamp: 2,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Run the checks')
    const status = screen.getByText('Working for 0 seconds')
    const assistant = screen.getByText('I am checking now.')
    expect(user.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.compareDocumentPosition(assistant)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.parentElement).toHaveClass('border-b')
  })

  it('shows elapsed working time once tool activity starts', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'tool-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now() - 3000}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Working for 3 seconds')).toBeInTheDocument()
  })

  it('keeps the completed duration below the user message', () => {
    const startedAt = Date.now() - 3000
    const turnSession: NativeChatLiveSession = {
      ...session,
      status: 'working',
      messages: [
        {
          id: 'user-complete',
          role: 'user',
          blocks: [{ type: 'text', text: 'Complete this task' }],
          timestamp: startedAt,
          source: 'transcript'
        },
        {
          id: 'assistant-complete',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Task complete.' }],
          timestamp: Date.now(),
          source: 'transcript'
        }
      ]
    }
    const { rerender } = render(
      <NativeChatMessageList
        session={turnSession}
        isWorking
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    rerender(
      <NativeChatMessageList
        session={{ ...turnSession, status: 'ready' }}
        isWorking={false}
        workingStartedAt={null}
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Complete this task')
    const status = screen.getByText('Worked for 3 seconds')
    const assistant = screen.getByText('Task complete.')
    expect(user.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.compareDocumentPosition(assistant)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(
      <NativeChatMessageList
        session={{
          ...turnSession,
          status: 'working',
          messages: [
            ...turnSession.messages,
            {
              id: 'user-next',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start another task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now()}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Worked for 3 seconds')).toBeInTheDocument()
    expect(screen.getByText('Thinking')).toBeInTheDocument()
  })

  it("uses the completed caret to expand that turn's tool details", () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'ready',
          messages: [
            {
              id: 'user-details',
              role: 'user',
              blocks: [{ type: 'text', text: 'Inspect the repo' }],
              timestamp: startedAt,
              source: 'transcript'
            },
            {
              id: 'assistant-details',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'pwd' },
                  state: 'completed'
                },
                { type: 'tool-result', output: '/repo' }
              ],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    const status = screen.getByRole('button', { name: 'Toggle turn details' })
    expect(status).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /1× shell/ })).toBeNull()
    fireEvent.click(status)
    expect(status).toHaveAttribute('aria-expanded', 'true')
    const tool = screen.getByRole('button', { name: /1× shell/ })
    expect(tool).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button', { name: /shell pwd/ })[1]).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
