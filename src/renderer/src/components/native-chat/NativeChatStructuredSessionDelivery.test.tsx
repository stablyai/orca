// The delivery notice and the outbox queue behind it: which entry a Retry acts
// on, and when no notice is owed at all. The automatic probe is in the .probe suite.

// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
    runtimeContext?: unknown
  },
  composerProps: null as null | {
    structuredTransport?: Record<string, unknown>
    isWorking?: boolean
  },
  questionCardProps: null as NativeChatQuestionCardProps | null,
  promptItems: [] as AgentJournalRenderItem[],
  noJournalItems: Array.of<AgentJournalRenderItem>(),
  respond: vi.fn(),
  handlePasteEvent: vi.fn(),
  pasteFromClipboard: vi.fn(),
  submissions: [] as unknown[],
  monitoringBackgroundTasks: false,
  supportsBackgroundTaskStop: false,
  supportsBackgroundTaskStopAll: true,
  backgroundTasks: [] as AgentSessionBackgroundTask[],
  stopBackgroundTask: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  // The pane activates the host status feed for its startup phase; nothing here drives it.
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
  const { projectStructuredAgentSessionMessages } =
    await import('../../../../shared/structured-agent-session-message-projection')
  return {
    useStructuredAgentSession: (props: {
      sessionId: string
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    }) => {
      const outbox = useStructuredAgentSessionOutbox({
        journalItems: mocks.noJournalItems,
        sessionId: props.sessionId,
        target: props.target,
        fence: 1,
        submissions: mocks.submissions as never
      })
      return {
        journalItems: [],
        messages:
          mocks.mode === 'outbox'
            ? projectStructuredAgentSessionMessages([], outbox.outbox, [], {
                rejectedInPlace: true
              })
            : [
                {
                  id: 'message-1',
                  role: 'assistant',
                  source: 'transcript',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: '[file](file:///repo/src/main.ts)' }]
                }
              ],
        status: 'ready' as const,
        error: outbox.error,
        hasOlder: false,
        loadingOlder: false,
        loadOlder: vi.fn(),
        prompts: mocks.promptItems,
        outbox: outbox.outbox,
        failedHere: outbox.failedHere,
        submissions: mocks.submissions,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: false,
        isMonitoringBackgroundTasks: mocks.monitoringBackgroundTasks,
        supportsBackgroundTaskStop: mocks.supportsBackgroundTaskStop,
        supportsBackgroundTaskStopAll: mocks.supportsBackgroundTaskStopAll,
        backgroundTasks: mocks.backgroundTasks,
        turnId: null,
        cancel: vi.fn(),
        queuedMessages: {
          cards: [],
          steer: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
          edit: vi.fn(async () => {}),
          steerNewest: () => false
        },
        stopBackgroundTask: (taskId?: string) => mocks.stopBackgroundTask(props.sessionId, taskId),
        respond: mocks.respond,
        optionSnapshot: [
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            kind: {
              type: 'select',
              currentValue: 'gpt-live',
              choices: [{ value: 'gpt-live', label: 'GPT Live' }]
            },
            valueSource: 'reported',
            settable: true
          }
        ],
        optionSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        setStructuredOption: vi.fn()
      }
    }
  }
})

vi.mock('./use-native-chat-font-size', () => ({
  useNativeChatFontSize: () => undefined
}))

vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    runtimeEnvironmentId: null
  })
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
}))

vi.mock('./NativeChatMessageList', async () => {
  const { DeliveryNoticesMock } = await import('./NativeChatStructuredSession.test-harness')
  return {
    NativeChatMessageList: (
      props: NonNullable<typeof mocks.messageListProps> & {
        deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
      }
    ) => {
      mocks.messageListProps = props
      return <DeliveryNoticesMock notices={props.deliveryNotices} />
    }
  }
})

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
    mocks.composerProps = props
    const fieldRef = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({
      // Match the real composer so focus ownership is observable in this split suite.
      focus: () => {
        fieldRef.current?.focus()
        return true
      },
      insertTypedText: () => true,
      handlePasteEvent: mocks.handlePasteEvent,
      pasteFromClipboard: mocks.pasteFromClipboard,
      contains: (node: Node | null) => fieldRef.current?.contains(node) === true
    }))
    return <textarea ref={fieldRef} data-testid="structured-composer" />
  })
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({
  NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
    mocks.questionCardProps = props
    return null
  }
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import {
  advanceProbeClock,
  seededEntry,
  seedOutbox,
  useProbeClock
} from './NativeChatStructuredSession.test-harness'
import {
  appendStructuredAgentSessionOutboxMessage,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

const REFUSED_RESTART = "The agent couldn't restart. Your message was not sent."

describe('NativeChatStructuredSession delivery', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.questionCardProps = null
    mocks.promptItems = []
    mocks.respond.mockReset()
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
    mocks.monitoringBackgroundTasks = false
    mocks.supportsBackgroundTaskStop = false
    mocks.supportsBackgroundTaskStopAll = true
    mocks.stopBackgroundTask.mockReset()
    mocks.backgroundTasks = []
  })

  // Resent under its own id until the host answers, so its row says only that it is still sending.
  it('says a send whose answer was lost is sending until it confirms on its own, with no Retry', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    await act(async () => {
      expect(send?.('hello', [])).toBe(true)
    })
    // From the moment it is sent, through the lost answer, until the host confirms it.
    expect(getStructuredAgentSessionOutbox('session-1')).toMatchObject([{ state: 'unconfirmed' }])
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()

    await advanceProbeClock(1000)
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1]?.[2]).toEqual(mocks.call.mock.calls[0]?.[2])
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(getStructuredAgentSessionOutbox('session-1')).toEqual([])
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
  }, 10000)

  // Reopened mid-send, the send is read back in doubt; the probe resends it under its own id.
  function seedMidSend(sessionId: string, patch: Record<string, unknown> = {}): void {
    seedOutbox(sessionId, [
      {
        ...seededEntry(sessionId, 'op-sent', 'first', 'queued'),
        state: 'dispatching',
        lastAttemptAt: 1,
        retryAfterUnknownSubmittedAt: null,
        ...patch
      }
    ])
  }

  function renderSession(sessionId: string): void {
    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId={`structured-tab-${sessionId}`}
        sessionId={sessionId}
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
  }

  it('says a send reopened mid-send is sending while it is resent, until it settles', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'op-sent', dispatchState: 'accepted' } }
    })
    seedMidSend('session-reopened')

    renderSession('session-reopened')

    expect(getStructuredAgentSessionOutbox('session-reopened')).toMatchObject([
      { clientMessageId: 'op-sent', state: 'unconfirmed' }
    ])
    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    await advanceProbeClock(1000)
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-sent' }
    })
    expect(getStructuredAgentSessionOutbox('session-reopened')).toEqual([])
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
  }, 10000)

  it('says a send reopened mid-send is unconfirmed, with its Retry, when the journal holds unknown', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    const sessionId = 'session-reopened-unknown'
    mocks.submissions = [
      {
        clientMessageId: 'op-sent',
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    seedMidSend(sessionId)

    renderSession(sessionId)

    expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.queryByText('Sending…')).toBeNull()
    await advanceProbeClock(1500)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('says a send a Stop outlived is unconfirmed when reopened, as nothing resends it', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    seedMidSend('session-reopened-stopped', { outlivedStop: true })

    renderSession('session-reopened-stopped')

    expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.queryByText('Sending…')).toBeNull()
    await advanceProbeClock(1500)
    expect(mocks.call).not.toHaveBeenCalled()
  }, 10000)

  it('retries the head, not a later stuck message', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })
    seedOutbox('session-retry-head', [
      seededEntry('session-retry-head', 'op-head', 'first', 'unconfirmed'),
      seededEntry('session-retry-head', 'op-later', 'second', 'unconfirmed')
    ])

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-retry-head"
        sessionId="session-retry-head"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const request = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    expect(request.envelope.clientOperationId).toBe('op-head')
  })

  it('offers a rejected message no Retry while the queue is stopped, and gives it back once it moves', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'op-head', dispatchState: 'accepted' } }
    })
    seedOutbox('session-held-rejected', [
      seededEntry('session-held-rejected', 'op-head', 'first', 'unconfirmed'),
      // Refused before the host recorded it, so its Retry is the only way it goes again.
      {
        ...seededEntry('session-held-rejected', 'op-rejected', 'second', 'queued'),
        state: 'rejected',
        lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
      }
    ])

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-held-rejected"
        sessionId="session-held-rejected"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())
    expect(screen.getByText(REFUSED_RESTART)).toBeTruthy()
    // One Retry, the stopped message's: it sends only that one.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-head' }
    })

    // The queue moved, so the rejected message offers its own Retry again.
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
    expect(screen.getByText(REFUSED_RESTART)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Retry/ })).toHaveLength(1)
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  // Until the journal carries the row, the message's own copy words it; the host has it, so no Retry.
  it("words a failed start its reply rejected by the chat's agent, with no Retry", async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: unknown,
        params: { envelope: { clientOperationId: string } }
      ) => ({
        ok: true,
        value: {
          clientMessageId: params.envelope.clientOperationId,
          submission: {
            clientMessageId: params.envelope.clientOperationId,
            fence: 1,
            payloadFingerprint: 'fingerprint',
            dispatchState: 'rejected',
            providerItemId: null,
            reason: 'Codex stopped before it finished starting. Send your message to try again.',
            rejection: { kind: 'providerStartFailed' },
            submittedAt: 1,
            resolvedAt: 2
          }
        }
      })
    )

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-start-failed"
        sessionId="session-start-failed"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() =>
      expect(
        screen.getByText(
          'Codex stopped before it finished starting. Send your message to try again.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  // A copy an earlier session left in the outbox gives way to the host's row.
  it("words a rejected message from its journal row, not the message's own copy, with no Retry", async () => {
    const reason = "Claude couldn't start. Send your message to try again."
    mocks.submissions = [
      {
        clientMessageId: 'op-recorded',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'rejected',
        providerItemId: null,
        reason,
        rejection: {
          kind: 'startFailed',
          refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
        },
        submittedAt: 1,
        resolvedAt: 1
      }
    ]
    seedOutbox('session-recorded', [
      {
        ...seededEntry('session-recorded', 'op-recorded', 'first', 'queued'),
        state: 'rejected',
        lastFailure: { kind: 'rejected', reason, rejection: { kind: 'startFailed' } }
      }
    ])

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-recorded"
        sessionId="session-recorded"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    await waitFor(() =>
      expect(screen.getByText("Codex couldn't start. Start a new chat to continue.")).toBeTruthy()
    )
    expect(screen.queryByText(reason)).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  })

  it('names the stuck message behind an admitted head, and its Retry sends that one', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    // The head is admitted -- written and awaiting the provider -- so the entry behind it is the
    // one holding the queue, and Retry acts on it instead of waiting for the head to clear.
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'op-head', dispatchState: 'pending' } }
    })
    seedOutbox('session-quiet-head', [
      seededEntry('session-quiet-head', 'op-head', 'first', 'queued'),
      seededEntry('session-quiet-head', 'op-later', 'second', 'unconfirmed')
    ])

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-quiet-head"
        sessionId="session-quiet-head"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-head' }
    })

    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-later' }
    })
  })

  // A cause seen while the chat was open is worded in full; one read back after the chat is
  // reopened may have cleared, until a Retry it still stops brings it back.
  it('words a refusal seen here in full, and after a reopen only once its Retry is refused', async () => {
    const newerOrca =
      'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        message: 'newer',
        details: { reason: 'journalWrittenByNewerOrca' }
      }
    })
    const view = (): React.JSX.Element => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="tab-held"
        sessionId="session-held"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const first = render(view())
    // The composer's own enqueue.
    act(() => {
      expect(appendStructuredAgentSessionOutboxMessage('session-held', 'hello')).not.toBeNull()
    })
    await waitFor(() => expect(screen.getByText(newerOrca)).toBeTruthy())
    first.unmount()

    render(view())
    await waitFor(() => expect(screen.getByText('Your message was not sent.')).toBeTruthy())
    expect(mocks.call).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(newerOrca)).toBeTruthy())
  })
})
