// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
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
  // An approval whose subject a newer Orca wrote, with no detail to show.
  const NEWER_APPROVAL: AgentJournalRenderItem = JSON.parse(
    JSON.stringify({
      itemId: 'approval-item',
      revision: 3,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'approval',
        title: 'Review proposed change',
        detail: null,
        subject: { kind: 'diff', path: 'a.ts' },
        options: [{ id: 'allow', label: 'Approve' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    })
  )

  it("hands the card a newer Orca's subject in a writable chat, and its cancel goes to the host with the card", () => {
    mocks.turnId = 'turn-1'
    mocks.promptItems = [NEWER_APPROVAL]
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="newer-approval-tab"
        sessionId="newer-approval-session"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    expect(mocks.approvalCardProps).toMatchObject({
      approval: { subject: { kind: 'diff' } }
    })
    expect(mocks.approvalCardProps?.approval).not.toHaveProperty('detail')
    mocks.approvalCardProps?.onCancel?.()
    expect(mocks.cancel).toHaveBeenCalledWith('turn-1', {
      itemId: 'approval-item',
      expectedRevision: 3
    })
  })

  it('sends nothing for the card when no turn is running', () => {
    mocks.promptItems = [NEWER_APPROVAL]
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="newer-approval-tab"
        sessionId="newer-approval-session"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
    mocks.approvalCardProps?.onCancel?.()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('cancels a Pi extension dialog outside a model turn', () => {
    mocks.promptItems = [NEWER_APPROVAL]
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="pi-dialog-tab"
        sessionId="pi-dialog-session"
        target={{ kind: 'local' }}
        agent="pi"
      />
    )
    mocks.approvalCardProps?.onCancel?.()
    expect(mocks.cancel).toHaveBeenCalledWith(undefined, {
      itemId: 'approval-item',
      expectedRevision: 3
    })
  })

  function renderSession() {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="newer-approval-tab"
        sessionId="newer-approval-session"
        target={{ kind: 'local' }}
        agent="claude"
      />
    )
  }

  it('keeps the composer open and writable beside a card this build cannot answer', () => {
    mocks.promptItems = [NEWER_APPROVAL]
    renderSession()
    expect(mocks.composerProps).not.toBeNull()
    expect(mocks.approvalCardProps).toMatchObject({ shouldFocus: false })
  })

  it('gives a card this build can answer the composer slot', () => {
    const plan: AgentJournalRenderItem = JSON.parse(
      JSON.stringify(NEWER_APPROVAL).replace(
        '{"kind":"diff","path":"a.ts"}',
        '{"kind":"plan","text":"do it"}'
      )
    )
    mocks.promptItems = [plan]
    renderSession()
    expect(mocks.composerProps).toBeNull()
    expect(mocks.approvalCardProps).toMatchObject({ shouldFocus: true })
  })
}

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

  it('renders the terminal refusal once beside the rejected message', async () => {
    const fact: AgentSessionFailureFact = { kind: 'conversationOpenInTerminal' }
    renderPane([rejected('terminal-held', 'Host fallback words.', fact)])
    const row = await notice('terminal-held')
    expect(row.textContent).toContain(
      'Claude is already running this conversation in another terminal. Quit Claude there or close that terminal to continue here.'
    )
    expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  // The start row owns the failure reason; resending a rejected message creates a new message.
  it("says only 'not sent', with no Retry, on each message the failed start's row explains", async () => {
    mocks.journalItems = [startFailureRow(START_FAILED)]

    renderPane([
      rejected('first', START_FAILED_REASON, START_FAILED),
      rejected('second', START_FAILED_REASON, START_FAILED)
    ])

    for (const id of ['first', 'second']) {
      const row = await notice(id)
      expect(within(row).getByText('Your message was not sent.')).toBeTruthy()
      expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull()
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
      rejected('other', "Claude didn't accept this message: Image type .bmp.", providerRejected)
    ])

    expect(within(await notice('stated')).getByText('Your message was not sent.')).toBeTruthy()
    expect(
      within(await notice('other')).getByText("Claude didn't accept this message: Image type .bmp.")
    ).toBeTruthy()
  })

  it("keeps the start failure's own words when its row is not loaded", async () => {
    renderPane([rejected('first', START_FAILED_REASON, START_FAILED)])

    expect(within(await notice('first')).getByText(START_FAILED_REASON)).toBeTruthy()
  })

  it.each([null, '0.100.0', '0.135.0'])(
    'states a missing or too-old Codex (installed version %s) in the existing failure notice',
    async (installedVersion) => {
      const failure: AgentSessionFailureFact = {
        kind: installedVersion === null ? 'cliMissing' : 'startFailed',
        ...(installedVersion === null
          ? {}
          : {
              refusal: {
                code: 'agent_session_operation_invalid',
                details: {
                  reason: 'attachFailed',
                  codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
                }
              }
            })
      }
      const { text } = agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
      renderPane([rejected('codex-message', text, failure)], 'codex')
      const row = await notice('codex-message')
      expect(within(row).getByText(text)).toBeTruthy()
      expect(text).toContain(
        installedVersion === null
          ? "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."
          : `Codex ${installedVersion} is too old for chats. Update to 0.136.0 or newer.`
      )
      if (installedVersion !== null) {
        expect(text).not.toContain('Settings → Agents')
      }
      expect(text).not.toContain('codex update')
    }
  )
}
