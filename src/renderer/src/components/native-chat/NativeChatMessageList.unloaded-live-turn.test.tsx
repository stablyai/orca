// @vitest-environment happy-dom

// A long turn's record and opening message sit above the loaded page. The host's newest turn record
// still names the turn, so its loaded rows draw under the live Working bar.

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { render } from './native-chat-app-root-test-render'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const TURN_RECORD = 'turn-record-1'
const IN_TURN: AgentJournalTurnScope = { kind: 'turn', turnItemId: TURN_RECORD }

/** The newest rows of the turn: everything from its 300th row on. */
const loaded: AgentJournalRenderItem[] = [300, 301, 302].map((sequence) => ({
  itemId: `row-${sequence}`,
  revision: 0,
  sequence,
  observedAt: sequence,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: `Step ${sequence}` }]
  },
  turnScope: IN_TURN
}))

const patch = '@@ -1 +1 @@\n-before\n+after'
/** An edit among the loaded rows; the turn's earlier edits are above them. */
const edit: AgentJournalRenderItem = {
  itemId: 'row-303',
  revision: 0,
  sequence: 303,
  observedAt: 303,
  body: {
    kind: 'diff',
    path: 'src/a.ts',
    patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
  },
  turnScope: IN_TURN
}

const running: AgentSessionLatestTurn = {
  itemId: TURN_RECORD,
  observedAt: 1,
  turn: { turnId: 'turn-1', state: 'running', startedAt: 1_000, userItemId: 'user-1' }
}

function list(
  latestTurn: AgentSessionLatestTurn | null | undefined,
  items: AgentJournalRenderItem[] = loaded
): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, [], [], { rejectedInPlace: true }),
        status: 'ready',
        sessionId: 'session-1',
        agent: 'codex',
        hasMore: true,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      journalItems={items}
      journalSubmissions={[]}
      journalLatestTurn={latestTurn}
      isWorking
      workingStartedAt={1_000}
      expandSignal={false}
    />
  )
}

describe('a live turn whose record and opening message are not loaded', () => {
  it('draws its Working bar with the running clock', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
    try {
      render(list(running))
      expect(screen.getByText('Step 302')).toBeInTheDocument()
      expect(screen.getByText(/Working for 1m 3s/)).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })

  it('totals no edits, since only the end of the turn is loaded', () => {
    render(list(running, [...loaded, edit]))
    expect(screen.getByText(/Working for/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /changed file/ })).toBeNull()
  })

  it('had no bar to draw from the loaded rows alone', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
    try {
      render(list(undefined))
      expect(screen.getByText('Step 302')).toBeInTheDocument()
      expect(screen.queryByText(/Working for/)).not.toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })
})
