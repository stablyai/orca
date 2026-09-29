// The delivery notice and the outbox queue behind it: which entry a Retry acts
// on, when no notice is owed at all, and how a host-confirmed unknown is probed.

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
        sessionId: props.sessionId,
        target: props.target,
        fence: 1,
        submissions: mocks.submissions as never
      })
      return {
        journalItems: [],
        messages:
          mocks.mode === 'outbox'
            ? projectStructuredAgentSessionMessages([], outbox.outbox, [])
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
        submissions: mocks.submissions,
        blockedClientMessageId: outbox.blockedClientMessageId,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: false,
        isMonitoringBackgroundTasks: mocks.monitoringBackgroundTasks,
        supportsBackgroundTaskStop: mocks.supportsBackgroundTaskStop,
        supportsBackgroundTaskStopAll: mocks.supportsBackgroundTaskStopAll,
        backgroundTasks: mocks.backgroundTasks,
        turnId: null,
        cancel: vi.fn(),
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

vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
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
      pasteFromClipboard: mocks.pasteFromClipboard
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

describe('NativeChatStructuredSession delivery', () => {
  afterEach(() => {
    cleanup()
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

  function seededEntry(
    sessionId: string,
    clientMessageId: string,
    text: string,
    state: 'queued' | 'unconfirmed'
  ) {
    return {
      clientMessageId,
      sessionId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      previewUris: [],
      state,
      queuedAt: clientMessageId === 'op-head' ? 1 : 2,
      lastAttemptAt: null,
      // Already force-retried once, so the automatic probe leaves the head alone
      // and only the user's Retry moves it.
      retryAfterUnknownSubmittedAt: -1
    }
  }

  function seedOutbox(sessionId: string, entries: unknown[]): void {
    localStorage.setItem(
      `orca:desktopStructuredAgentSessionOutbox:v1:${encodeURIComponent(sessionId)}`,
      JSON.stringify(entries)
    )
  }

  it('retries an unconfirmed transport send and clears the delivery notice', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce({
      ok: true,
      value: {
        submission: {
          clientMessageId: 'client-1',
          dispatchState: 'accepted'
        }
      }
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
    expect(send?.('hello', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  })

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
      {
        ...seededEntry('session-held-rejected', 'op-rejected', 'second', 'queued'),
        state: 'rejected',
        lastFailure: { kind: 'rejected', reason: 'Claude messages support at most 20 images' }
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
    expect(screen.getByText('Claude messages support at most 20 images')).toBeTruthy()
    // One Retry, the stopped message's: it sends only that one.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
      envelope: { clientOperationId: 'op-head' }
    })

    // The queue moved, so the rejected message offers its own Retry again.
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
    expect(screen.getByText('Claude messages support at most 20 images')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Retry/ })).toHaveLength(1)
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it("words a failed start on each message by the chat's agent, leaving the resend to its Retry", async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    const startFailed = (clientMessageId: string, text: string) => ({
      ...seededEntry('session-start-failed', clientMessageId, text, 'queued'),
      state: 'rejected' as const,
      lastFailure: {
        kind: 'rejected' as const,
        reason: 'Codex stopped before it finished starting. Send your message to try again.',
        rejection: { kind: 'providerStartFailed' as const }
      }
    })
    seedOutbox('session-start-failed', [
      startFailed('op-first', 'first'),
      startFailed('op-second', 'second')
    ])

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

    await waitFor(() =>
      expect(screen.getAllByText('Codex stopped before it finished starting.')).toHaveLength(2)
    )
    expect(screen.getAllByRole('button', { name: /Retry/ })).toHaveLength(2)
    expect(screen.queryByText(/Send your message to try again/)).toBeNull()
  })

  it("words a rejected message from its loaded journal row, not the message's own copy", async () => {
    mocks.mode = 'outbox'
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

  it('resends a transport-unconfirmed head so later messages are not wedged', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-wedge"
        sessionId="session-wedge"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    expect(send?.('second', [])).toBe(true)
    // The head is probed automatically, clears, and the queue drains.
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3), { timeout: 10000 })
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  }, 20000)

  it('probes the same operation without marking an explicit user retry', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-probe-flag"
        sessionId="session-probe-flag"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 10000 })

    const first = mocks.call.mock.calls[0]?.[2] as Record<string, unknown>
    const probe = mocks.call.mock.calls[1]?.[2] as Record<string, unknown>
    expect(probe.retryUnknown).toBeUndefined()
    // Same operation id: both dedupe layers key off it.
    expect((probe.envelope as { clientOperationId: string }).clientOperationId).toBe(
      (first.envelope as { clientOperationId: string }).clientOperationId
    )
  }, 20000)

  it('draws a host-confirmed unknown as sent: never re-sent, and the next message goes out', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-parked"
        sessionId="session-parked"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    const sent = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    // The host recorded it and cannot tell whether the agent took it: drawn as sent.
    mocks.submissions = [
      {
        clientMessageId: sent.envelope.clientOperationId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'unknown',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    // The next message re-renders with the new submissions, and nothing holds it back.
    await act(async () => {
      send?.('second', [])
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    })
    const texts = mocks.call.mock.calls.map((call) => call[2]?.body?.blocks?.[0]?.text)
    expect(texts).toEqual(['first', 'second'])
  }, 20000)

  it('still probes while streaming batches rebuild the submissions array', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (): React.ReactElement => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-churn"
        sessionId="session-churn"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )
    const { rerender } = render(makeView())

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // Each batch mints a fresh submissions array for an unrelated message. An
    // array-identity dependency restarts the backoff on every one of these, so a
    // stream that outlasts the delay would never let the probe fire.
    for (let index = 0; index < 12; index += 1) {
      mocks.submissions = [
        {
          clientMessageId: `other-${index}`,
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: index,
          resolvedAt: index
        }
      ]
      await act(async () => {
        rerender(makeView())
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
    }

    // Asserted with no trailing grace period: the probe must have fired *during*
    // the stream, not after it went quiet.
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('restarts probe delay when the runtime target changes', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    const makeView = (
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    ) => (
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-target-switch"
        sessionId="session-target-switch"
        target={target}
        agent="codex"
      />
    )
    const { rerender } = render(makeView({ kind: 'local' }))
    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    rerender(makeView({ kind: 'environment', environmentId: 'env-1' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2), { timeout: 1500 })
  }, 10000)

  it('never auto-probes an entry the user already force-retried', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    // Both the original send and the user's explicit Retry fail at the transport.
    mocks.call.mockRejectedValue(new Error('socket closed'))

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-forced"
        sessionId="session-forced"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    // User retries with the same envelope and no legacy redelivery signal.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const forcedRequest = mocks.call.mock.calls[1]?.[2] as Record<string, unknown> | undefined
    expect(forcedRequest?.retryUnknown).toBeUndefined()

    // That retry also failed at the transport. The probe must not repeat an
    // explicit retry automatically.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    })
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('does not hot-loop when the host answers pending', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'pending' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-pending"
        sessionId="session-pending"
        target={{ kind: 'local' }}
        agent="codex"
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    // A pending row parks the entry under the backoff instead of re-dispatching
    // immediately. Without that, this window is an unbounded back-to-back RPC flood.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
    })
    expect(mocks.call.mock.calls.length).toBeLessThanOrEqual(3)
  }, 20000)

  it('keeps probing past the old five-attempt budget', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValue(new Error('socket closed'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(
        <NativeChatStructuredSession
          isVisible
          isFocusedGroup
          tabId="structured-tab-budget"
          sessionId="session-budget"
          target={{ kind: 'local' }}
          agent="codex"
        />
      )

      const send = mocks.composerProps?.structuredTransport?.send as
        | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
        | undefined
      expect(send?.('first', [])).toBe(true)

      // Backoff is 1+2+4+8+16 = 31s for five probes, which was the old hard budget.
      // Step past it; a seventh call proves the probe re-arms instead of giving up.
      for (let step = 0; step < 12; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_000)
        })
      }
      expect(mocks.call.mock.calls.length).toBeGreaterThanOrEqual(7)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)
})
