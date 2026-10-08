// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

function retry(sequence: number, attempt: number): AgentJournalRenderItem {
  return {
    itemId: `retry-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        {
          kind: 'providerRetrying',
          detail: { text: `Reconnecting... ${attempt}/5`, audience: 'person' },
          retry: { cause: 'stream disconnected before completion' }
        },
        { surface: 'row', agentName: 'Codex' }
      )
    }
  }
}

function transcript(items: AgentJournalRenderItem[]) {
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, [], []),
        status: 'ready',
        sessionId: 'live-codex',
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      isWorking={false}
      expandSignal
    />
  )
}

describe('a Codex retrying a dropped stream', () => {
  it('draws one warning for the run, with what failed on its second line', () => {
    render(transcript([retry(1, 1), retry(2, 2), retry(3, 3)]))

    const rows = screen.getAllByText(/Codex is retrying/)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toBe(
      'Codex is retrying: Reconnecting... 3/5.\nstream disconnected before completion'
    )
  })
})
