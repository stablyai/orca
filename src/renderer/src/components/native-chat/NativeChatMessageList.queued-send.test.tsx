// @vitest-environment happy-dom

// What the transcript shows for a send the provider has accepted but not
// started: its own wait, on its own row, beside the running turn's counter —
// and, once the turn settles, the wait beside the duration rather than inside it.

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionQueuedSend } from '../../../../shared/structured-agent-session-queued-sends'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'

const QUEUED_ID = agentJournalSubmissionKey('m2')

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => {
  restoreViewport()
  vi.useRealTimers()
})
afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [],
  status: 'working',
  sessionId: 'session-1',
  agent: 'claude',
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

function messages(): NativeChatLiveSession['messages'] {
  return [
    {
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'First question' }],
      timestamp: 1_000,
      source: 'transcript'
    },
    {
      id: QUEUED_ID,
      role: 'user',
      blocks: [{ type: 'text', text: 'Second question' }],
      timestamp: 34_000,
      source: 'transcript'
    }
  ]
}

function queuedSends(
  waitingOn: StructuredAgentSessionQueuedSend['waitingOn']
): ReadonlyMap<string, StructuredAgentSessionQueuedSend> {
  return new Map([[QUEUED_ID, { clientMessageId: 'm2', submittedAt: 34_000, waitingOn }]])
}

describe('NativeChatMessageList queued send', () => {
  it('reports the wait on the queued row while the running turn keeps its own counter', () => {
    vi.useFakeTimers({ now: 167_000 })
    try {
      render(
        <NativeChatMessageList
          session={{ ...session, messages: messages() }}
          journalItems={[]}
          isWorking
          workingStartedAt={107_000}
          queuedSends={queuedSends('turn-busy')}
          showTurnStatus
          expandSignal={false}
          fontScale={1}
        />
      )

      // The send was accepted 133s ago; the turn that is blocking it has run 60s.
      expect(screen.getByText('Queued — waiting for the current turn · 2m 13s')).toBeInTheDocument()
      expect(screen.getByText('Working for 1m 0s')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the turn is starting when nothing is running yet', () => {
    vi.useFakeTimers({ now: 37_000 })
    try {
      render(
        <NativeChatMessageList
          session={{ ...session, messages: messages() }}
          journalItems={[]}
          isWorking
          queuedSends={queuedSends('turn-starting')}
          showTurnStatus
          expandSignal={false}
          fontScale={1}
        />
      )

      expect(screen.getByText('Queued — starting · 3s')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the queued line once the provider starts the turn', () => {
    render(
      <NativeChatMessageList
        session={{ ...session, messages: messages() }}
        journalItems={[]}
        isWorking
        queuedSends={new Map()}
        showTurnStatus
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.queryByText(/^Queued/)).not.toBeInTheDocument()
  })

  it('reports the wait beside the settled duration, never folded into it', () => {
    const settledTurns: NativeChatSettledTurns = new Map([
      [QUEUED_ID, { startedAt: 134_000, workedSeconds: 40, queuedSeconds: 133 }]
    ])
    render(
      <NativeChatMessageList
        session={{ ...session, status: 'ready', messages: messages() }}
        journalItems={[]}
        isWorking={false}
        settledTurns={settledTurns}
        showTurnStatus
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Worked for 40s · queued 2m 13s')).toBeInTheDocument()
  })
})
