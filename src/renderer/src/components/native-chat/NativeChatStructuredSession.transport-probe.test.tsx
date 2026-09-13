// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('NativeChatStructuredSession transport-unconfirmed sends', () => {
  afterEach(() => {
    cleanup()
    resetStructuredSessionMocks()
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

  it('parks a host-confirmed unknown instead of probing it', async () => {
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
