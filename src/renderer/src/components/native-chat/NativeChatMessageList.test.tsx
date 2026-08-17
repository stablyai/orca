/* @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(cleanup)

describe('NativeChatMessageList', () => {
  it('uses the shared animated disclosure and keeps spacing before the final answer', () => {
    const { container } = render(
      <NativeChatMessageList
        session={session([
          message('user', 'user', 'Start', 1000),
          message('detail', 'assistant', 'Activity detail', 2000, 'commentary'),
          message('answer', 'assistant', 'Final answer', 3000, 'final')
        ])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    const view = within(container)
    expect(view.queryByText('Activity detail')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Worked for 2s' }))
    expect(
      view
        .getByText('Activity detail')
        .closest('[data-slot="collapsible-content"]')
        ?.classList.contains('chat-activity-disclosure-content')
    ).toBe(true)
    expect(container.querySelector('article')?.firstElementChild?.classList.contains('mb-2')).toBe(
      true
    )
    expect(view.getByText('Final answer').closest('[data-slot="collapsible-content"]')).toBeNull()
  })

  it('places user actions beside the bubble and assistant actions below the response', () => {
    render(
      <NativeChatMessageList
        session={session([
          message('user-1', 'user', 'Hello', 1),
          message('assistant-1', 'assistant', 'Hi', 2, 'final')
        ])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const userBubble = screen.getByText('Hello').closest('.rounded-2xl')
    expect(userBubble?.previousElementSibling?.querySelector('[aria-label="Copy message"]')).toBe(
      screen.getAllByRole('button', { name: 'Copy message' })[0]
    )
    const assistantRow = screen.getByText('Hi').closest('.group')
    expect(assistantRow?.lastElementChild?.querySelector('[aria-label="Copy message"]')).toBe(
      screen.getAllByRole('button', { name: 'Copy message' })[1]
    )
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
  })

  it('shows a non-expandable duration for a completed final-only turn', () => {
    const session: NativeChatLiveSession = {
      agent: 'codex',
      sessionId: 'session-1',
      status: 'ready',
      context: EMPTY_AGENT_SESSION_CONTEXT,
      markCompactionRequested: () => undefined,
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => undefined,
      readPhase: 'ready',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          source: 'stream',
          timestamp: 1_000,
          blocks: [{ type: 'text', text: 'Hello' }]
        },
        {
          id: 'final-1',
          role: 'assistant',
          source: 'stream',
          assistantPhase: 'final',
          timestamp: 5_000,
          blocks: [{ type: 'text', text: 'Hi' }]
        }
      ]
    }

    render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByRole('button', { name: 'Worked for 4s' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('keeps one turn header above chronological activity and steer', () => {
    const messages: NativeChatMessage[] = [
      message('user-1', 'user', 'Start', 1),
      message('before', 'assistant', 'Before steer', 2, 'commentary'),
      message('steer', 'user', 'Change course', 3),
      message('after', 'assistant', 'Course changed', 4, 'commentary')
    ].map((entry) => ({ ...entry, turnId: 'turn-1' }))
    const { container } = render(
      <NativeChatMessageList
        session={session(messages, 'working')}
        isWorking
        activeTurnId="turn-1"
        workingStartedAt={1}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(within(container).queryByText('@codex')).toBeNull()
    expect(within(container).getAllByText('Thinking')).toHaveLength(1)
    const content = container.textContent ?? ''
    expect(content.indexOf('Thinking')).toBeLessThan(content.indexOf('Before steer'))
    expect(content.indexOf('Before steer')).toBeLessThan(content.indexOf('Change course'))
    expect(content.indexOf('Change course')).toBeLessThan(content.indexOf('Course changed'))
  })

  it('does not show Worked for an interrupted partial response', () => {
    const { container } = render(
      <NativeChatMessageList
        session={session([
          { ...message('user-1', 'user', 'Start', 1), turnId: 'turn-1' },
          { ...message('partial', 'assistant', 'Partial', 2), turnId: 'turn-1' }
        ])}
        isWorking={false}
        turnCompletions={{
          'turn-1': { outcome: 'interrupted', completedAt: 3 }
        }}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(within(container).getByText('Interrupted')).toBeTruthy()
    expect(within(container).queryByText(/Worked for/)).toBeNull()
  })
})

function session(
  messages: NativeChatMessage[],
  status: NativeChatLiveSession['status'] = 'ready'
): NativeChatLiveSession {
  return {
    agent: 'codex',
    sessionId: 'session-1',
    status,
    context: EMPTY_AGENT_SESSION_CONTEXT,
    markCompactionRequested: () => undefined,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => undefined,
    readPhase: 'ready',
    messages
  }
}

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  timestamp: number,
  assistantPhase?: NativeChatMessage['assistantPhase']
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'stream',
    ...(assistantPhase ? { assistantPhase } : {})
  }
}
