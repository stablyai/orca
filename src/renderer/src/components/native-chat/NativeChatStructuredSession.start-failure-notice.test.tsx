// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStructuredSessionMocks()
})

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
    } satisfies AgentJournalSubmission
  }
}

function renderPane(messages: ReturnType<typeof rejected>[]): void {
  mocks.mode = 'outbox'
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
      agent="claude"
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

// The start's own row says why, so its rejected messages say only that they were not sent.
it("says only 'not sent', with its Retry, on each message the failed start's row explains", async () => {
  mocks.journalItems = [startFailureRow(START_FAILED)]

  renderPane([
    rejected('first', START_FAILED_REASON, START_FAILED),
    rejected('second', START_FAILED_REASON, START_FAILED)
  ])

  for (const id of ['first', 'second']) {
    const row = await notice(id)
    expect(within(row).getByText('Your message was not sent.')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeTruthy()
  }
  expect(screen.queryByText(/stopped before it finished starting/)).toBeNull()
})

it('keeps the full notice on a message rejected for a reason no start-failure row states', async () => {
  mocks.journalItems = [startFailureRow(START_FAILED)]
  const providerRejected: AgentSessionFailureFact = {
    kind: 'providerRejected',
    detail: { text: 'Image type .bmp', audience: 'person' }
  }

  renderPane([
    rejected('stated', START_FAILED_REASON, START_FAILED),
    rejected(
      'other',
      'The provider did not accept this message: Image type .bmp.',
      providerRejected
    )
  ])

  expect(within(await notice('stated')).getByText('Your message was not sent.')).toBeTruthy()
  expect(
    within(await notice('other')).getByText(
      'The provider did not accept this message: Image type .bmp.'
    )
  ).toBeTruthy()
})

it("keeps the start failure's own words when its row is not loaded", async () => {
  renderPane([rejected('first', START_FAILED_REASON, START_FAILED)])

  expect(
    within(await notice('first')).getByText('Claude stopped before it finished starting.')
  ).toBeTruthy()
})

// Another window, or the sender after its entry is gone: the host's record alone says it.
it('words a recorded rejection this window holds no outbox entry for, with no Retry', async () => {
  const userRow = (clientMessageId: string, sequence: number): AgentJournalRenderItem => ({
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  })
  const providerRejected: AgentSessionFailureFact = {
    kind: 'providerRejected',
    detail: { text: 'Image type .bmp', audience: 'person' }
  }
  mocks.journalItems = [startFailureRow(START_FAILED), userRow('stated', 2), userRow('other', 3)]
  const submissions = [
    rejected('stated', START_FAILED_REASON, START_FAILED).submission,
    rejected(
      'other',
      'The provider did not accept this message: Image type .bmp.',
      providerRejected
    ).submission
  ]
  mocks.submissions = submissions
  mocks.messages = projectStructuredAgentSessionMessages(mocks.journalItems, [], submissions)
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="start-failure-tab"
      sessionId={SESSION_ID}
      target={{ kind: 'local' }}
      agent="claude"
    />
  )

  expect(within(await notice('stated')).getByText('Your message was not sent.')).toBeTruthy()
  expect(
    within(await notice('other')).getByText(
      'The provider did not accept this message: Image type .bmp.'
    )
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
