// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { render } from './native-chat-app-root-test-render'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'

const turnItem: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }

function journalItem(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-stop',
      role: 'user',
      blocks: [{ type: 'text', text: 'Start the task' }],
      timestamp: Date.now(),
      source: 'transcript'
    }
  ],
  status: 'working',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

// The turn still runs while a Stop ends it, so its bar keeps the running clock; only the tail line
// says the turn is stopping, and the bar settles to "Interrupted after" once the turn ends.
describe("the turn bar while a person's Stop ends the turn", () => {
  it('keeps the running clock above the Stopping tail line', () => {
    render(
      <NativeChatMessageList
        session={session}
        journalItems={[journalItem(1, turnItem)]}
        isWorking
        stopping
        expandSignal={false}
      />
    )

    const bar = screen.getByText('Working for 0s')
    const stopping = screen.getByText('Stopping…')
    expect(bar.compareDocumentPosition(stopping)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getAllByText(/Stopping/)).toHaveLength(1)
  })
})

// Where the host does not queue sends, one made while Stopping is held until the turn ends: it is
// drawn after the Stopping line, not inside the turn being stopped.
describe('a message sent while Stopping, before the host has handed it over', () => {
  const pending = {
    id: 'pending-send',
    role: 'user' as const,
    sentWhileStopping: true as const,
    blocks: [{ type: 'text' as const, text: 'Run this after the stop' }],
    timestamp: Date.now(),
    source: 'transcript' as const
  }

  function renderList(stopping: boolean): void {
    render(
      <NativeChatMessageList
        session={{ ...session, messages: [...session.messages, pending] }}
        journalItems={[journalItem(1, turnItem)]}
        isWorking
        stopping={stopping}
        expandSignal={false}
      />
    )
  }

  it('draws after the Stopping line', () => {
    renderList(true)

    const stopping = screen.getByText('Stopping…')
    const sent = screen.getByText('Run this after the stop')
    expect(stopping.compareDocumentPosition(sent)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('stays in the turn while nothing is stopping', () => {
    renderList(false)

    const sent = screen.getByText('Run this after the stop')
    const working = screen.getByText('Working…')
    expect(sent.compareDocumentPosition(working)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  // Sent just before the Stop, the host steers it into the turn: it stays there, never jumping.
  it('keeps a send made before the Stop in the turn', () => {
    const { sentWhileStopping: _made, ...beforeStop } = pending
    render(
      <NativeChatMessageList
        session={{ ...session, messages: [...session.messages, beforeStop] }}
        journalItems={[journalItem(1, turnItem)]}
        isWorking
        stopping
        expandSignal={false}
      />
    )

    const sent = screen.getByText('Run this after the stop')
    const stopping = screen.getByText('Stopping…')
    expect(sent.compareDocumentPosition(stopping)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
