// @vitest-environment happy-dom

import { cleanup, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

{
  const SESSION_ID = 'start-failure-session'
  const START_FAILED: AgentSessionFailureFact = { kind: 'providerStartFailed' }
  const START_FAILED_REASON =
    'Claude stopped before it finished starting. Send your message to try again.'

  function startFailureRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
    return {
      itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1')),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
      }
    }
  }

  function rejected(clientMessageId: string, reason: string, rejection: AgentSessionFailureFact) {
    return {
      outbox: {
        clientMessageId,
        sessionId: SESSION_ID,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
        previewUris: [],
        state: 'rejected',
        queuedAt: 1,
        lastAttemptAt: null,
        retryAfterUnknownSubmittedAt: null,
        lastFailure: { kind: 'rejected', reason, rejection: { kind: rejection.kind } }
      },
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: clientMessageId,
        dispatchState: 'rejected',
        providerItemId: null,
        reason,
        rejection,
        submittedAt: 1,
        resolvedAt: 1
      }
    }
  }

  // The notices are the host's rows'; a copy an earlier session left in the outbox gives way to them.
  function renderPane(
    messages: ReturnType<typeof rejected>[],
    agent: 'claude' | 'codex' = 'claude'
  ): void {
    mocks.submissions = messages.map((message) => message.submission)
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${encodeURIComponent(SESSION_ID)}`,
      JSON.stringify(messages.map((message) => message.outbox))
    )
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="start-failure-tab"
        sessionId={SESSION_ID}
        target={{ kind: 'local' }}
        agent={agent}
      />
    )
  }

  async function notice(clientMessageId: string): Promise<HTMLElement> {
    return waitFor(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-message-id="${agentJournalSubmissionKey(clientMessageId)}"]`
      )
      if (!row) {
        throw new Error(`no notice on ${clientMessageId}`)
      }
      return row
    })
  }

  it('keeps the full notice on a message rejected for a reason no start-failure row states', async () => {
    mocks.journalItems = [startFailureRow(START_FAILED)]
    const providerRejected: AgentSessionFailureFact = {
      kind: 'providerRejected',
      detail: { text: 'Image type .bmp', audience: 'person' }
    }

    renderPane([
      rejected('stated', START_FAILED_REASON, START_FAILED),
      rejected('other', "Claude didn't accept this message: Image type .bmp.", providerRejected)
    ])

    expect(within(await notice('stated')).getByText('Your message was not sent.')).toBeTruthy()
    expect(
      within(await notice('other')).getByText("Claude didn't accept this message: Image type .bmp.")
    ).toBeTruthy()
  })
}
