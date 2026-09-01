// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { forwardRef, useImperativeHandle } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
  },
  composerProps: null as null | { structuredTransport?: Record<string, unknown> },
  handlePasteEvent: vi.fn(),
  pasteFromClipboard: vi.fn(),
  submissions: [] as unknown[]
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
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
        messages:
          mocks.mode === 'outbox'
            ? []
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
        prompts: [],
        outbox: outbox.outbox,
        blockedClientMessageId: outbox.blockedClientMessageId,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: false,
        turnId: null,
        cancel: vi.fn(),
        respond: vi.fn(),
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

vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: (props: typeof mocks.messageListProps) => {
    mocks.messageListProps = props
    return <div data-testid="message-list" />
  }
}))

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
    mocks.composerProps = props
    useImperativeHandle(ref, () => ({
      focus: () => true,
      insertTypedText: () => true,
      handlePasteEvent: mocks.handlePasteEvent,
      pasteFromClipboard: mocks.pasteFromClipboard
    }))
    return <textarea data-testid="structured-composer" />
  })
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({ NativeChatQuestionCard: () => null }))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.messageListProps = null
    mocks.composerProps = null
    mocks.handlePasteEvent.mockReset()
    mocks.pasteFromClipboard.mockReset()
    mocks.submissions = []
  })

  it('routes app-menu paste into the structured composer', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-paste"
        sessionId="session-paste"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    const composer = screen.getByTestId('structured-composer')
    composer.focus()
    window.dispatchEvent(new Event('orca-app-menu-paste', { cancelable: true }))

    expect(mocks.pasteFromClipboard).toHaveBeenCalledOnce()
  })

  it('wires local structured file links through the native chat opener', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    expect(mocks.messageListProps?.allowFileUriLinks).toBe(true)
    expect(mocks.messageListProps?.onLinkClick).toBe(mocks.fileLinkClick)
  })

  it('routes a bare model command to the native option picker', async () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )
    const dispatchCommand = mocks.composerProps?.structuredTransport?.dispatchCommand as
      | ((text: string) => Promise<{ accepted: boolean }>)
      | undefined

    await act(async () => {
      await expect(dispatchCommand?.('/model')).resolves.toMatchObject({ accepted: true })
    })

    expect(mocks.composerProps?.structuredTransport?.optionPickerRequest).toEqual({
      id: 'model',
      sequence: 1
    })
  })

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
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
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
        tabId="structured-tab-wedge"
        sessionId="session-wedge"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
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

  it('probes without retryUnknown so the host cannot redispatch', async () => {
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-probe-flag"
        sessionId="session-probe-flag"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
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

  it('parks a host-confirmed unknown instead of probing it', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue({
      ok: true,
      value: { submission: { clientMessageId: 'client-1', dispatchState: 'accepted' } }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-parked"
        sessionId="session-parked"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())

    const sent = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    // The host now reports it as an unresolved unknown: redispatch is the user's call.
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
    // Queue a second message purely to re-render so the effect observes the
    // new submissions; it must stay wedged behind the parked head.
    await act(async () => {
      send?.('second', [])
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    })
    expect(mocks.call).toHaveBeenCalledOnce()
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
        tabId="structured-tab-churn"
        sessionId="session-churn"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
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
        tabId="structured-tab-target-switch"
        sessionId="session-target-switch"
        target={target}
        agent="codex"
        allowFileUriLinks
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
        tabId="structured-tab-forced"
        sessionId="session-forced"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('first', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    // User force-retries: this request legitimately carries retryUnknown.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const forcedRequest = mocks.call.mock.calls[1]?.[2] as Record<string, unknown> | undefined
    expect(forcedRequest?.retryUnknown).toBe(true)

    // That retry also failed at the transport. The probe must NOT pick it up, or it
    // would re-send retryUnknown automatically and redispatch to the agent.
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
        tabId="structured-tab-pending"
        sessionId="session-pending"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
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
          tabId="structured-tab-budget"
          sessionId="session-budget"
          target={{ kind: 'local' }}
          agent="codex"
          allowFileUriLinks
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
