// The automatic probe of an unconfirmed outbox head: when it resends under the same
// operation id, and when it parks the entry for the user's Retry instead.

// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import {
  advanceProbeClock,
  seededEntry,
  seedOutbox,
  useProbeClock
} from './NativeChatStructuredSession.test-harness'

describe('NativeChatStructuredSession delivery probe', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    localStorage.clear()
    resetStructuredSessionMocks()
  })

  it('resends a transport-unconfirmed head so later messages are not wedged', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    await act(async () => {
      expect(send?.('second', [])).toBe(true)
    })
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    // The head is probed automatically, clears, and the queue drains.
    expect(mocks.call).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull()
  }, 20000)

  it('probes the same operation without marking an explicit user retry', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledTimes(2)

    const first = mocks.call.mock.calls[0]?.[2] as Record<string, unknown>
    const probe = mocks.call.mock.calls[1]?.[2] as Record<string, unknown>
    expect(probe.retryUnknown).toBeUndefined()
    // Same operation id: both dedupe layers key off it.
    expect((probe.envelope as { clientOperationId: string }).clientOperationId).toBe(
      (first.envelope as { clientOperationId: string }).clientOperationId
    )
  }, 20000)

  it('parks a host-confirmed unknown instead of probing it', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    const sent = mocks.call.mock.calls[0]?.[2] as { envelope: { clientOperationId: string } }
    // The host now reports an unresolved unknown: another replay is the user's call.
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
    await advanceProbeClock(3000)
    // From the row on, only the user's Retry moves it, so it says so.
    expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy()
    expect(mocks.call).toHaveBeenCalledOnce()
  }, 20000)

  it('still probes while streaming batches rebuild the submissions array', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

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
        await vi.advanceTimersByTimeAsync(250)
      })
    }

    // Asserted with no trailing grace period: the probe must have fired *during*
    // the stream, not after it went quiet.
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 20000)

  it('restarts probe delay when the runtime target changes', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    await advanceProbeClock(300)
    rerender(makeView({ kind: 'environment', environmentId: 'env-1' }))
    await advanceProbeClock(600)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(399)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledTimes(2)
  }, 10000)

  it('never auto-probes an entry the user already force-retried', async () => {
    useProbeClock()
    mocks.mode = 'outbox'
    mocks.submissions = []
    mocks.call.mockRejectedValue(new Error('socket closed'))
    seedOutbox('session-forced', [seededEntry('session-forced', 'op-head', 'first', 'unconfirmed')])

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

    await advanceProbeClock(3000)
    // Only the user's Retry moves it, so it says so.
    expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy()
    expect(mocks.call).not.toHaveBeenCalled()
  }, 20000)

  it('does not hot-loop when the host answers pending', async () => {
    useProbeClock()
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
    await act(async () => {
      expect(send?.('first', [])).toBe(true)
    })
    expect(mocks.call).toHaveBeenCalledOnce()

    // A host-pending entry stays parked until the journal answers it.
    await advanceProbeClock(999)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1)
    expect(mocks.call).toHaveBeenCalledOnce()
    await advanceProbeClock(1500)
    expect(mocks.call).toHaveBeenCalledOnce()
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
