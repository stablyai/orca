// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

// A message sent while the agent starts: the host holds it, nothing has answered it yet.
const pendingSend: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix the build' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'working',
  sessionId: 'session-1',
  agent: 'claude',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

function activityRows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('[data-native-chat-turn-activity]')
}

describe('NativeChatMessageList while the agent starts', () => {
  it('names the starting state on the working indicator, then swaps it in place at ready', () => {
    const { container, rerender } = render(
      <NativeChatMessageList
        session={pendingSend}
        isWorking
        agentStarting
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(activityRows(container)).toHaveLength(1)
    const row = activityRows(container)[0]
    expect(row).toHaveTextContent(/^Starting…$/)
    expect(screen.queryByText('Working…')).toBeNull()

    rerender(
      <NativeChatMessageList
        session={pendingSend}
        isWorking
        agentStarting={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(activityRows(container)).toHaveLength(1)
    expect(activityRows(container)[0]).toBe(row)
    expect(row).toHaveTextContent(/^Working…$/)
  })

  // Nothing sent: the startup is internal, so no indicator says anything about it.
  it('shows nothing for a starting agent with no unanswered send', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{ ...pendingSend, status: 'ready' }}
        isWorking={false}
        agentStarting
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(activityRows(container)).toHaveLength(0)
    expect(screen.queryByText('Starting…')).toBeNull()
  })
})
