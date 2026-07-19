// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

afterEach(() => cleanup())

const taskMessages: NativeChatMessage[] = [
  {
    id: 'task-create',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      { type: 'tool-call', name: 'TaskCreate', input: { subject: 'Add tests' } },
      { type: 'tool-result', output: '{"task":{"id":"7","subject":"Add tests"}}' }
    ]
  }
]

function session(agent: AgentType): NativeChatLiveSession {
  return {
    agent,
    sessionId: 'session',
    status: 'ready',
    messages: taskMessages,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn()
  }
}

describe('NativeChatMessageList Claude tasks', () => {
  it('leaves identically named tools untouched for non-Claude agents', () => {
    render(
      <NativeChatMessageList
        session={session('codex')}
        isWorking={false}
        expandSignal
        fontScale={1}
      />
    )

    expect(screen.getByText('TaskCreate')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /task \(/i })).not.toBeInTheDocument()
  })

  it('renders OpenClaude task tools as a checklist without duplicate tool rows', () => {
    render(
      <NativeChatMessageList
        session={session('openclaude')}
        isWorking={false}
        expandSignal
        fontScale={1}
      />
    )

    expect(
      screen.getByRole('region', { name: '1 task (0 done, 0 in progress, 1 open)' })
    ).toBeInTheDocument()
    expect(screen.queryByText('TaskCreate')).not.toBeInTheDocument()
  })
})
