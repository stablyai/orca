// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'

afterEach(cleanup)

function frame(id: number, status: string, overrides: { kind?: string; truncated?: boolean } = {}) {
  const kind = overrides.kind ?? 'notification:turn/plan/updated'
  const head = JSON.stringify({
    threadId: 'thread',
    turnId: 'turn',
    explanation: 'Keep verification visible',
    plan: [{ step: 'Verify', status }]
  })
  const body: AgentJournalStatusItem = {
    kind: 'status',
    text: `codex · ${kind}`,
    providerFrame: {
      provider: 'codex',
      kind,
      payload: {
        head,
        byteLength: new TextEncoder().encode(head).byteLength,
        digest: 'fixture-digest',
        truncated: overrides.truncated ?? false
      }
    }
  }
  const message = projectStructuredItemToNativeChat({
    itemId: `frame-${id}`,
    revision: 1,
    sequence: id,
    observedAt: id,
    body
  })
  if (!message) {
    throw new Error('Expected a projected message')
  }
  return message
}

function transcript(messages: NativeChatMessage[], sessionId = 'live-codex') {
  return (
    <NativeChatMessageList
      session={{
        messages,
        status: 'ready',
        sessionId,
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      isWorking={false}
      expandSignal
      fontScale={1}
      showTurnStatus={false}
    />
  )
}

describe('live Codex checklist frames', () => {
  it('updates one pinned checklist from journal notifications without rewinding on pagination', () => {
    const first = frame(1, 'pending')
    const active = frame(2, 'inProgress')
    const last = frame(3, 'completed')
    const { rerender, container } = render(transcript([first]))
    const toggle = screen.getByRole('button', { name: 'Tasks 0 of 1 tasks completed' })
    const viewport = container.querySelector('.overflow-y-auto')!
    expect(viewport.contains(toggle)).toBe(false)
    fireEvent.click(toggle)
    rerender(transcript([first, active]))
    expect(within(toggle.parentElement!).getByText('Verify').closest('li')).toHaveClass(
      'text-foreground'
    )
    expect(within(viewport as HTMLElement).getByText('Started Verify')).toBeInTheDocument()
    rerender(transcript([last]))
    expect(
      within(
        screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }).parentElement!
      ).getByText('Verify')
    ).toHaveClass('line-through')
    expect(screen.getAllByText('Keep verification visible')).toHaveLength(2)
    rerender(transcript([first, active, last]))
    expect(screen.getAllByText('Verify')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' })).toBe(toggle)
    expect(screen.getByText('Started Verify')).toBeInTheDocument()
    expect(screen.queryByText('notification:turn/plan/updated')).toBeNull()
    expect(projectNativeChatTaskListFrames([last])[0]).toBe(
      projectNativeChatTaskListFrames([last])[0]
    )
  })

  it('uses the latest complete snapshot across Codex tool calls and notifications', () => {
    const tool: NativeChatMessage = {
      id: 'tool',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Verify', status: 'pending' }] }
        }
      ]
    }
    render(transcript([tool, frame(3, 'completed')]))
    fireEvent.click(screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }))
    expect(screen.getAllByText('Verify')).toHaveLength(2)
    expect(
      within(
        screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }).parentElement!
      ).getByText('Verify')
    ).toHaveClass('line-through')
  })

  it('keeps malformed, truncated, other-provider, and plan-document frames unchanged', () => {
    const truncated = frame(1, 'pending', { truncated: true })
    const document = frame(2, 'pending', { kind: 'item:plan' })
    const malformed = frame(3, 'pending')
    const otherProvider = frame(4, 'pending')
    const malformedBlock = malformed.blocks[0]
    const otherBlock = otherProvider.blocks[0]
    if (malformedBlock.type === 'text' && malformedBlock.providerFrame) {
      malformedBlock.providerFrame.payload.head = '{"plan":null}'
    }
    if (otherBlock.type === 'text' && otherBlock.providerFrame) {
      otherBlock.providerFrame.provider = 'claude'
    }
    const messages = [truncated, document, malformed, otherProvider]
    const projected = projectNativeChatTaskListFrames(messages)
    projected.forEach((message, index) => expect(message).toBe(messages[index]))
    render(transcript([truncated]))
    expect(screen.getByText('notification:turn/plan/updated')).toBeInTheDocument()
    expect(screen.queryByText('Tasks')).toBeNull()
  })

  it('does not consume a neighboring tool failure as a notification result', () => {
    const command: NativeChatMessage = {
      id: 'command',
      role: 'assistant',
      timestamp: 2,
      source: 'transcript',
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'verify' }, state: 'failed' },
        { type: 'tool-result', output: 'Verification failed', isError: true }
      ]
    }
    render(transcript([frame(1, 'pending'), command]))
    expect(screen.getByRole('button', { name: 'Tasks 0 of 1 tasks completed' })).toBeInTheDocument()
    expect(screen.getByText('Verification failed', { selector: 'pre' })).toHaveClass(
      'text-destructive'
    )
  })
})

describe('NativeChatMessageList task list history', () => {
  it('keeps the latest Claude state after pagination and resets disclosure between sessions', () => {
    const first = {
      id: 'first-list',
      role: 'assistant' as const,
      timestamp: 1,
      source: 'transcript' as const,
      blocks: [
        {
          type: 'tool-call' as const,
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read', status: 'pending' },
              { content: 'Test', status: 'pending' }
            ]
          }
        }
      ]
    }
    const last = {
      ...first,
      id: 'last-list',
      timestamp: 3,
      blocks: [
        { type: 'text' as const, text: 'Ready for verification' },
        {
          type: 'tool-call' as const,
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read', status: 'completed' },
              { content: 'Test', status: 'pending' }
            ]
          }
        }
      ]
    }
    const { rerender } = render(transcript([last]))
    fireEvent.click(screen.getByRole('button', { name: 'Tasks 1 of 2 tasks completed' }))
    rerender(transcript([first, last]))
    expect(screen.getAllByText('Read')).toHaveLength(2)
    expect(screen.getByText('Completed Read')).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('button', { name: 'Tasks 1 of 2 tasks completed' }).parentElement!
      ).getByText('Read')
    ).toHaveClass('line-through')
    expect(screen.getByText('Ready for verification')).toBeInTheDocument()
    rerender(transcript([first], 'two'))
    expect(screen.getByRole('button', { name: 'Tasks 0 of 2 tasks completed' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getAllByText('Read')).toHaveLength(1)
    rerender(transcript([], 'three'))
    expect(screen.queryByText('Tasks')).toBeNull()
  })
})
