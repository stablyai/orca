// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

afterEach(cleanup)

let restoreViewport = (): void => {}

beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})

afterAll(() => restoreViewport())

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-settled',
      role: 'user',
      blocks: [{ type: 'text', text: 'Settled on the host' }],
      timestamp: 1,
      source: 'transcript'
    },
    {
      id: 'assistant-settled',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Done.' }],
      timestamp: 2,
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

const settledTurns = new Map([['user-settled', { startedAt: 1, workedSeconds: 197 }]])

describe('NativeChatMessageList host-settled turn timing', () => {
  it('does not render a local completed duration when the host cannot verify the end', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const unknownTurns = new Map([['user-settled', null]])
    try {
      const { rerender } = render(
        <NativeChatMessageList
          session={session}
          isWorking
          workingStartedAt={1_000}
          settledTurns={unknownTurns}
          expandSignal={false}
          fontScale={1}
        />
      )
      now.mockReturnValue(60_000)
      rerender(
        <NativeChatMessageList
          session={session}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={unknownTurns}
          expandSignal={false}
          fontScale={1}
        />
      )
      expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })

  it('renders a host-settled duration without ever clocking the turn locally', () => {
    // A local clock nowhere near the host's: the value must still be the host's.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const { rerender } = render(
        <NativeChatMessageList
          session={session}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={settledTurns}
          expandSignal={false}
          fontScale={1}
        />
      )
      expect(screen.getByText('Worked for 3m 17s')).toBeInTheDocument()
      now.mockReturnValue(1_700_000_099_000)
      rerender(
        <NativeChatMessageList
          session={{ ...session }}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={settledTurns}
          expandSignal={false}
          fontScale={1}
        />
      )
      expect(screen.getByText('Worked for 3m 17s')).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })
})
